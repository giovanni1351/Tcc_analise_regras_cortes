import { Context, Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { targetEventClasses } from "@tcc/contracts";
import { BlobStore, MediaProbe } from "../services.ts";
import { commandOutput } from "../media/index.ts";
import { Process } from "../process.ts";
import { AttemptLedger } from "../llm/ledger.ts";
import { reservationFor } from "../llm/admission.ts";
import { Repository, defaultSpec } from "../jobs/repository.ts";
import { stageKey } from "../jobs/keys.ts";
import { LlmStep } from "../jobs/stages.ts";
import {
  ComparisonError,
  comparisonModel,
  aggregate,
  pairedBootstrap,
  scoreSegment,
  type BenchmarkRow,
} from "./compare.ts";

const makeComparison = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const blobs = yield* BlobStore;
  const probe = yield* MediaProbe;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository;
  const ledger = yield* AttemptLedger;
  const llm = yield* LlmStep;
  const process = yield* Process;
  return {
    run: Effect.fn("Comparison.run")(
      function* (
        rows: ReadonlyArray<BenchmarkRow>,
        options: {
          dryRun: boolean;
          retryAmbiguous: boolean;
          budget: number;
          fallbackRate: number;
          outputRate: number;
        },
      ) {
        yield* ledger.recoverOnStartup;
        const clips = [];
        const recorded = yield* sql<{
          rate: number | null;
        }>`SELECT MAX(a.cost_usd/s.duration_sec) AS rate FROM llm_attempts a JOIN segments s ON s.id=a.segment_id WHERE a.model=${comparisonModel} AND s.duration_sec>0`;
        const pricing = {
          highestRecordedUsdPerSecond: Math.max(recorded[0]?.rate ?? 0, options.fallbackRate),
          outputUsdPerToken: options.outputRate,
        };
        for (const row of rows) {
          const clip = yield* Effect.scoped(
            Effect.gen(function* () {
              const temp = yield* blobs.tempPath("mp4");
              yield* commandOutput("ffmpeg", [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                String(row.start_seconds),
                "-to",
                String(row.end_seconds),
                "-i",
                row.source_video_path,
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                temp,
              ]);
              return {
                row,
                blob: yield* blobs.publish(temp, "mp4"),
                durationSec: row.end_seconds - row.start_seconds,
              };
            }),
          );
          clips.push(clip);
        }
        const estimate = clips.reduce(
          (sum, clip) => sum + reservationFor(comparisonModel, clip.durationSec, 4096, pricing),
          0,
        );
        if (options.dryRun)
          return {
            dryRun: true,
            reservationEstimateUsd: estimate,
            budgetUsd: options.budget,
            segments: clips.map((c) => ({
              segmentId: c.row.segment_id,
              blob: c.blob,
              reservationUsd: reservationFor(comparisonModel, c.durationSec, 4096, pricing),
            })),
          };
        const first = clips[0];
        if (!first)
          return yield* new ComparisonError({
            operation: "run",
            resource: "segments",
            cause: "Empty sample",
          });
        const media = yield* probe.probe(yield* blobs.path(first.blob));
        const source = yield* repo.register(
          { _tag: "LocalFile", path: media.path },
          media.hash,
          media.probe,
          media.sourceStat.size,
          media.sourceStat.mtimeMs,
        );
        const job = yield* sql.withTransaction(
          Effect.gen(function* () {
            const job = yield* repo.create(
              source.id,
              {
                ...defaultSpec,
                llm: {
                  model: comparisonModel,
                  promptVersion: "benchmark-v1",
                  maxCostUsd: options.budget,
                },
              },
              true,
            );
            yield* repo.change(job.id, { _tag: "Cancel" });
            if (options.retryAmbiguous)
              yield* sql`INSERT INTO retry_permissions SELECT ${job.id},id FROM llm_attempts WHERE state='Ambiguous'`;
            return job;
          }),
        );
        const key = yield* stageKey(
          "verdicts",
          "paired-comparison-v1",
          { jobId: job.id },
          clips.map((c) => c.blob),
        );
        yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES (${key},'verdicts','paired-comparison-v1','{}','Running')`;
        const segments = [];
        for (const [index, clip] of clips.entries()) {
          const id = `${key}:${index}`;
          yield* sql`INSERT INTO windows VALUES (${id},${key},${clip.row.start_seconds},${clip.row.end_seconds},'[]')`;
          yield* sql`INSERT INTO segments VALUES (${id},${key},${id},${clip.blob},${clip.row.start_seconds},${clip.durationSec})`;
          segments.push({
            id,
            windowId: id,
            windowIndex: index,
            start: clip.row.start_seconds,
            end: clip.row.end_seconds,
            blob: clip.blob,
            clipStart: clip.row.start_seconds,
            durationSec: clip.durationSec,
          });
        }
        const artifactPath = yield* blobs.tempPath("json");
        yield* fs.writeFileString(artifactPath, JSON.stringify(segments));
        const result = yield* llm.run(
          {
            job,
            media,
            inputs: [{ stage: "segments", key, artifactPath }],
            retryAmbiguous: options.retryAmbiguous,
            progress: () => Effect.void,
          },
          key,
        );
        const pairs: {
          segmentId: string;
          blob: string;
          stratum: string;
          includeNotShown: boolean;
          glmState: string;
          glmCostUsd: number | null;
          baselineCostUsd: number | null;
          glm: ReturnType<typeof scoreSegment>;
          baseline: ReturnType<typeof scoreSegment>;
        }[] = [];
        for (const clip of clips) {
          const answered = yield* sql<{
            verdict_json: string | null;
            cost_usd: number | null;
            state: string;
          }>`SELECT a.verdict_json,a.cost_usd,a.state FROM llm_attempts a JOIN segments s ON s.id=a.segment_id WHERE s.blob_hash=${clip.blob} AND a.model=${comparisonModel} AND a.prompt_version='benchmark-v1' AND a.inference_json='{"maxTokens":4096}' ORDER BY (a.state='Answered') DESC,a.updated_at DESC,a.id DESC LIMIT 1`;
          const answer = answered[0];
          pairs.push({
            segmentId: clip.row.segment_id,
            blob: clip.blob,
            stratum: clip.row.selection_stratum,
            includeNotShown: clip.row.include_hidden !== 0,
            glmState: answer?.state ?? "NotSent",
            glmCostUsd: answer?.cost_usd ?? null,
            baselineCostUsd: clip.row.cost_usd,
            glm: scoreSegment(clip.row, answer?.state === "Answered" ? answer.verdict_json : null),
            baseline: scoreSegment(clip.row, clip.row.response_text),
          });
        }
        const summarize = (model: "glm" | "baseline") => {
          const costs = pairs.map((p) => (model === "glm" ? p.glmCostUsd : p.baselineCostUsd));
          const knownCostUsd = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
          const unknownCostSegments = costs.filter((cost) => cost === null).length;
          const totalCostUsd = unknownCostSegments ? null : knownCostUsd;
          return {
            ...aggregate(pairs.map((p) => p[model])),
            validOutputRate: pairs.filter((p) => p[model].valid).length / pairs.length,
            perClass: Object.fromEntries(
              targetEventClasses.map((c) => [
                c,
                aggregate(pairs.map((p) => p[model].perClass[c] ?? { tp: 0, fp: 0, fn: 0 })),
              ]),
            ),
            knownCostUsd,
            unknownCostSegments,
            totalCostUsd,
            meanCostPerSegmentUsd: totalCostUsd === null ? null : totalCostUsd / pairs.length,
          };
        };
        yield* sql`UPDATE stage_runs SET status=${result.partial ? "Partial" : "Finished"} WHERE key=${key}`;
        const spent = yield* sql<{
          cost: number;
        }>`SELECT COALESCE(SUM(cost_usd),0) AS cost FROM llm_attempts WHERE job_id=${job.id}`;
        return {
          dryRun: false,
          ledgerJobId: job.id,
          chargedThisRunUsd: spent[0]?.cost ?? 0,
          reservationEstimateUsd: estimate,
          coverage: result.coverage,
          partial: result.partial ?? null,
          missingOutputsScoredAsEmpty: true,
          glm: summarize("glm"),
          baseline: summarize("baseline"),
          bootstrap: pairedBootstrap(pairs),
          segments: pairs,
        };
      },
      Effect.scoped,
      Effect.provideService(Process, process),
      Effect.mapError(
        (cause) => new ComparisonError({ operation: "run", resource: "comparison", cause }),
      ),
    ),
  };
});

export class Comparison extends Context.Service<
  Comparison,
  Effect.Success<typeof makeComparison>
>()("@tcc/server/eval/compare-run/Comparison") {}
export const comparisonLayer = Layer.effect(Comparison, makeComparison);
