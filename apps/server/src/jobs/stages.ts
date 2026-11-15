import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  JobError,
  Highlight,
  MediaHash,
  Coverage,
  type Job,
  PartialReason,
  type StageName,
  type StageRunKey,
} from "@tcc/contracts";
import { BlobStore, type Device, type ProbedMedia } from "../services.ts";
import { Repository, now, newId, persistence } from "./repository.ts";
import { stageKey } from "./keys.ts";

export const stages: ReadonlyArray<StageName> = [
  "probe",
  "scenes",
  "detections",
  "windows",
  "segments",
  "verdicts",
  "highlights",
];
export interface StageInput {
  readonly job: Job;
  readonly media: ProbedMedia;
  readonly inputs: ReadonlyArray<{
    readonly stage: StageName;
    readonly key: StageRunKey;
    readonly artifactPath: string;
  }>;
  readonly retryAmbiguous: boolean;
  readonly partial?: PartialReason;
  readonly progress: (done: number, total: number) => Effect.Effect<void>;
}
export interface StageOutput {
  readonly artifact: unknown;
  readonly device: Device | null;
  readonly writeRows: (key: StageRunKey) => Effect.Effect<void, JobError, SqlClient.SqlClient>;
  readonly coverage?: Coverage;
  readonly partial?: PartialReason;
}
export class StageLogic extends Context.Service<
  StageLogic,
  {
    readonly version: (stage: StageName) => string;
    readonly params: (stage: StageName, job: Job) => unknown;
    readonly run: (
      stage: StageName,
      input: StageInput,
      key: StageRunKey,
    ) => Effect.Effect<StageOutput, JobError>;
  }
>()("@tcc/server/jobs/stages/StageLogic") {}
export class LlmStep extends Context.Service<
  LlmStep,
  {
    readonly run: (input: StageInput, key: StageRunKey) => Effect.Effect<StageOutput, JobError>;
  }
>()("@tcc/server/jobs/stages/LlmStep") {}

const stageResult = Schema.Struct({
  coverage: Schema.optionalKey(Coverage),
  partial: Schema.optionalKey(PartialReason),
});

export const makeStageRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const blobs = yield* BlobStore;
  const fs = yield* FileSystem.FileSystem;
  const logic = yield* StageLogic;
  const repo = yield* Repository;
  const llm = yield* LlmStep;
  const execute = Effect.fn("Stages.execute")(function* (stage: StageName, input: StageInput) {
    const params = {
      config: logic.params(stage, input.job),
      ...(stage === "highlights"
        ? {
            half: ((source) => (source.ref._tag === "SoccerNetHalf" ? source.ref.half : null))(
              yield* repo.source(input.job.sourceId),
            ),
          }
        : {}),
    };
    const version = logic.version(stage);
    const key = yield* stageKey(stage, version, params, [
      input.media.hash,
      ...input.inputs
        .filter((i) =>
          stage === "verdicts"
            ? i.stage === "segments"
            : stage === "highlights"
              ? i.stage === "verdicts"
              : true,
        )
        .map((i) => i.key),
    ]);
    const cached = yield* sql<{
      artifact_hash: string;
      result_json: string;
    }>`SELECT artifact_hash,result_json FROM stage_runs WHERE key=${key} AND status='Finished'`.pipe(
      persistence("findStage"),
    );
    const link = sql`INSERT INTO job_stages VALUES (${input.job.id},${stage},${key}) ON CONFLICT(job_id,stage) DO UPDATE SET stage_run_key=excluded.stage_run_key`;
    const found = cached[0];
    if (found) {
      const hash = yield* Schema.decodeEffect(Schema.String)(found.artifact_hash);
      const artifactPath = yield* blobs.path(yield* Schema.decodeEffect(MediaHash)(hash));
      if (stage === "highlights") {
        const highlights = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Highlight)),
        )(yield* fs.readFileString(artifactPath));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM highlights WHERE job_id=${input.job.id}`;
              for (const highlight of highlights)
                yield* sql`INSERT INTO highlights VALUES (${yield* newId},${input.job.id},${highlight.class},${highlight.half},${highlight.videoSeconds},${highlight.confidence},${highlight.segmentId},${highlight.attemptId},${highlight.clipUrl?.split("/").at(-1) ?? null})`;
            }),
          )
          .pipe(persistence("reuseHighlights"));
      }
      yield* link.pipe(persistence("linkStage"));
      const result = yield* Schema.decodeEffect(Schema.fromJsonString(stageResult))(
        found.result_json,
      ).pipe(persistence("stageResult"));
      return { stage, key, artifactPath, coverage: result.coverage, partial: result.partial };
    }
    const started = yield* now;
    yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status,started_at) VALUES (${key},${stage},${version},${JSON.stringify(params)},'Running',${started}) ON CONFLICT(key) DO UPDATE SET status='Running',started_at=excluded.started_at,finished_at=NULL,artifact_hash=NULL`.pipe(
      persistence("startStage"),
    );
    yield* link.pipe(persistence("linkStage"));
    const executed = yield* stage === "verdicts"
      ? llm.run(input, key)
      : logic.run(stage, input, key);
    const output = input.partial ? { ...executed, partial: input.partial } : executed;
    const temp = yield* blobs.tempPath("json");
    yield* fs
      .writeFileString(temp, JSON.stringify(output.artifact))
      .pipe(persistence("writeArtifact"));
    const hash = yield* blobs.publish(temp, "json");
    const finished = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* output.writeRows(key);
          yield* sql`UPDATE stage_runs SET status=${output.partial ? "Partial" : "Finished"},finished_at=${finished},device=${output.device},artifact_hash=${hash},result_json=${JSON.stringify({ coverage: output.coverage, partial: output.partial })} WHERE key=${key}`;
        }),
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql), persistence("finishStage"));
    return {
      stage,
      key,
      artifactPath: yield* blobs.path(hash),
      coverage: output.coverage,
      partial: output.partial,
    };
  });
  return { execute };
});
export class StageRuns extends Context.Service<StageRuns, Effect.Success<typeof makeStageRuns>>()(
  "@tcc/server/jobs/stages/StageRuns",
) {}
export const stageRunsLayer = Layer.effect(StageRuns, makeStageRuns);
