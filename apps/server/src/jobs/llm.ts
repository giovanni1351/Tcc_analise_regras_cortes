import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { JobError, type PartialReason } from "@tcc/contracts";
import { BlobStore, OpenRouter } from "../services.ts";
import { AttemptLedger } from "../llm/ledger.ts";
import { isRetryable } from "../llm/openrouter.ts";
import { parseVerdict } from "../llm/verdict.ts";
import { reservationFor } from "../llm/admission.ts";
import { segmentArtifact } from "./pipeline.ts";
import { LlmStep } from "./stages.ts";
import { emptyCoverage, newId } from "./repository.ts";

export const llmStepLayer = (accountCapUsd: number) =>
  Layer.effect(
    LlmStep,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const blobs = yield* BlobStore;
      const provider = yield* OpenRouter;
      const ledger = yield* AttemptLedger;
      const fallbackRate = yield* Config.Number("OPENROUTER_RESERVATION_USD_PER_SECOND").pipe(
        Config.withDefault(0.001),
      );
      const outputRate = yield* Config.Number("OPENROUTER_OUTPUT_USD_PER_TOKEN").pipe(
        Config.withDefault(0.00001),
      );
      return {
        run: Effect.fn("LlmStep.run")(
          function* (input, key) {
            const artifact = input.inputs.find((item) => item.stage === "segments");
            if (!artifact)
              return yield* new JobError({
                stage: "verdicts",
                category: "InvalidInput",
                message: "Missing segments",
              });
            const segments = yield* Schema.decodeEffect(Schema.fromJsonString(segmentArtifact))(
              yield* fs.readFileString(artifact.artifactPath),
            );
            const coverage = { ...emptyCoverage, segments: segments.length };
            let partial: PartialReason | undefined;
            const model = input.job.spec.llm.model;
            const recorded = yield* sql<{
              rate: number | null;
            }>`SELECT MAX(a.cost_usd/s.duration_sec) AS rate FROM llm_attempts a JOIN segments s ON s.id=a.segment_id WHERE a.model=${model} AND s.duration_sec>0`;
            for (const segment of segments) {
              const reused = yield* sql<{
                verdict_json: string | null;
              }>`SELECT a.verdict_json FROM llm_attempts a JOIN segments s ON s.id=a.segment_id WHERE a.state='Answered' AND a.model=${model} AND a.prompt_version=${input.job.spec.llm.promptVersion} AND s.blob_hash=${segment.blob} AND a.inference_json='{"maxTokens":4096}' ORDER BY a.updated_at DESC,a.id DESC LIMIT 1`;
              if (reused[0]) {
                if (reused[0].verdict_json === null) coverage.invalid++;
                else coverage.valid++;
                continue;
              }
              const unresolved = yield* sql`
                SELECT a.id FROM llm_attempts a JOIN segments s ON s.id=a.segment_id
                WHERE a.state IN ('Sent','Ambiguous') AND a.model=${model}
                AND a.prompt_version=${input.job.spec.llm.promptVersion}
                AND s.blob_hash=${segment.blob} AND a.inference_json='{"maxTokens":4096}'
                AND NOT (a.state='Ambiguous' AND ${input.retryAmbiguous ? 1 : 0}=1 AND EXISTS (SELECT 1 FROM retry_permissions p WHERE p.job_id=${input.job.id} AND p.attempt_id=a.id)) LIMIT 1`;
              if (unresolved.length && !model.endsWith(":free")) {
                coverage.ambiguous++;
                continue;
              }
              if (partial) {
                coverage.notSent++;
                continue;
              }
              const numbers = yield* sql<{
                n: number;
              }>`SELECT COALESCE(MAX(attempt_number),0) AS n FROM llm_attempts WHERE segment_id=${segment.id} AND model=${model} AND prompt_version=${input.job.spec.llm.promptVersion}`;
              for (let retry = 0; retry < 3; retry++) {
                const id = yield* newId;
                const reservation = reservationFor(model, segment.durationSec, 4096, {
                  highestRecordedUsdPerSecond: Math.max(recorded[0]?.rate ?? 0, fallbackRate),
                  outputUsdPerToken: outputRate,
                });
                const clipPath = yield* blobs.path(segment.blob);
                const outcome = yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const admitted = yield* ledger.reserve({
                      id,
                      verdictKey: key,
                      jobId: input.job.id,
                      segmentId: segment.id,
                      model,
                      promptVersion: input.job.spec.llm.promptVersion,
                      attemptNumber: (numbers[0]?.n ?? 0) + retry + 1,
                      reservation,
                      jobCapUsd: input.job.spec.llm.maxCostUsd,
                      accountCapUsd,
                    });
                    if (!admitted) return { _tag: "Denied" } as const;
                    yield* ledger.markSent(id);
                    const response = yield* restore(
                      provider.complete({
                        model,
                        promptVersion: input.job.spec.llm.promptVersion,
                        maxTokens: 4096,
                        clipPath,
                      }),
                    ).pipe(
                      Effect.result,
                      Effect.onInterrupt(() =>
                        ledger.fail(id, "Interrupted during provider request").pipe(Effect.orDie),
                      ),
                    );
                    if (response._tag === "Success") {
                      const parsed = parseVerdict(response.success, segment.durationSec);
                      yield* ledger.answer(id, response.success, parsed);
                      return { _tag: "Answered", valid: parsed._tag === "Valid" } as const;
                    }
                    const error = response.failure;
                    if (error.category === "Moderation") {
                      yield* ledger.answer(
                        id,
                        {
                          httpStatus: error.httpStatus ?? 403,
                          body: error.responseBody ?? error.message,
                          generationId: null,
                          costUsd: 0,
                          latencyMs: 0,
                        },
                        { _tag: "Invalid", reason: error.message },
                      );
                      return { _tag: "Answered", valid: false } as const;
                    }
                    yield* ledger.fail(id, error);
                    return { _tag: "Failed", error } as const;
                  }),
                );
                if (outcome._tag === "Denied") {
                  coverage.notSent++;
                  const totals = yield* sql<{
                    committed: number;
                  }>`SELECT COALESCE(SUM(cost_usd),0) AS committed FROM llm_attempts WHERE job_id=${input.job.id}`;
                  partial = {
                    _tag: "BudgetExceeded",
                    capUsd: input.job.spec.llm.maxCostUsd,
                    committedUsd: totals[0]?.committed ?? 0,
                  };
                  break;
                }
                if (outcome._tag === "Answered") {
                  if (outcome.valid) coverage.valid++;
                  else coverage.invalid++;
                  break;
                }
                const error = outcome.error;
                if (error.quotaPeriod === "day") {
                  coverage.notSent++;
                  partial = { _tag: "FreeDailyLimit", retryAfterMs: error.retryAfterMs ?? 0 };
                  break;
                }
                const ambiguous =
                  error.sent !== false &&
                  !(error.category === "Upstream" && error.httpStatus === 200) &&
                  (error.httpStatus === null ||
                    (error.httpStatus >= 200 && error.httpStatus < 400));
                if (ambiguous && !model.endsWith(":free")) {
                  coverage.ambiguous++;
                  break;
                }
                if (isRetryable(error) && retry < 2) {
                  yield* Effect.sleep(Math.max(error.retryAfterMs ?? 0, 1000 * 2 ** retry));
                  continue;
                }
                return yield* new JobError({
                  stage: "verdicts",
                  category: "Provider",
                  message: error.message,
                });
              }
              yield* input.progress(
                coverage.valid + coverage.invalid + coverage.ambiguous + coverage.notSent,
                segments.length,
              );
            }
            if (!partial && coverage.ambiguous)
              partial = { _tag: "AmbiguousAttempts", count: coverage.ambiguous };
            return {
              artifact: coverage,
              device: null,
              coverage,
              ...(partial ? { partial } : {}),
              writeRows: () => Effect.void,
            };
          },
          Effect.mapError((cause) =>
            Schema.is(JobError)(cause)
              ? cause
              : new JobError({
                  stage: "verdicts",
                  category: "Persistence",
                  message: String(cause),
                }),
          ),
        ),
      } satisfies LlmStep["Service"];
    }),
  );
