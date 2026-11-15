import { Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  FrameIndex,
  JobError,
  MediaHash,
  VideoSeconds,
  type StageRunKey,
  type StageName,
  type JobSpec,
} from "@tcc/contracts";
import {
  ClipEncoder,
  ObjectDetector,
  SceneDetector,
  type CandidateWindow,
  type PlannedSegment,
} from "../services.ts";
import type { computeWindows } from "../domain/rules.ts";
import { cvParams, cvProvenance, cvStageParams } from "../cv/provenance.ts";
import { StageLogic, type StageInput, type StageOutput } from "./stages.ts";

const sceneSchema = Schema.Struct({
  sceneId: Schema.Number,
  startFrame: FrameIndex,
  endFrame: FrameIndex,
  startSec: VideoSeconds,
  durationSec: Schema.Number,
});
const sampleSchema = Schema.Struct({
  frameIndex: FrameIndex,
  timeSec: VideoSeconds,
  counts: Schema.Struct({
    player: Schema.Number,
    goalkeeper: Schema.Number,
    referee: Schema.Number,
    ball: Schema.Number,
  }),
});
const windowSchema = Schema.Struct({
  start: VideoSeconds,
  end: VideoSeconds,
  anchors: Schema.Array(VideoSeconds),
});
export const segmentArtifact = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    windowId: Schema.String,
    windowIndex: Schema.Number,
    start: VideoSeconds,
    end: VideoSeconds,
    blob: MediaHash,
    clipStart: VideoSeconds,
    durationSec: Schema.Number,
  }),
);
export interface PipelineFunctions {
  readonly version: (stage: StageName) => string;
  readonly params: (stage: StageName, spec?: JobSpec) => unknown;
  readonly computeWindows: typeof computeWindows;
  readonly planSegments: (
    windows: ReadonlyArray<CandidateWindow>,
    spec?: JobSpec,
  ) => ReadonlyArray<PlannedSegment>;
  readonly highlights: (input: StageInput) => Effect.Effect<StageOutput, JobError>;
}
export const pipelineLayer = (functions: PipelineFunctions) =>
  Layer.effect(
    StageLogic,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scenes = yield* SceneDetector;
      const objects = yield* ObjectDetector;
      const clips = yield* ClipEncoder;
      const provenance = yield* cvProvenance();
      const read = Effect.fn("Pipeline.read")(function* <A>(
        input: StageInput,
        stage: StageName,
        schema: Schema.Codec<A, unknown>,
      ) {
        const artifact = input.inputs.find((item) => item.stage === stage);
        if (!artifact)
          return yield* new JobError({
            stage,
            category: "InvalidInput",
            message: `Missing ${stage} artifact`,
          });
        const toError = (cause: unknown) =>
          new JobError({ stage, category: "Persistence", message: String(cause) });
        const text = yield* fs.readFileString(artifact.artifactPath).pipe(Effect.mapError(toError));
        return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(toError),
        );
      });
      const execute = Effect.fn("Pipeline.execute")(function* (
        stage: StageName,
        input: StageInput,
        runKey: StageRunKey,
      ) {
        const inferenceError = (cause: unknown) =>
          new JobError({ stage, category: "Inference", message: String(cause) });
        const rowsError = (cause: unknown) =>
          new JobError({ stage, category: "Persistence", message: String(cause) });
        switch (stage) {
          case "probe":
            return {
              artifact: input.media.probe,
              device: null,
              writeRows: () => Effect.void,
            } satisfies StageOutput;
          case "scenes": {
            const output = yield* scenes.detect(input.media).pipe(Effect.mapError(inferenceError));
            return {
              artifact: output.items,
              device: output.device,
              writeRows: Effect.fn("Pipeline.writeRows")(function* (key: StageRunKey) {
                const sql = yield* SqlClient.SqlClient;
                for (const scene of output.items)
                  yield* sql`INSERT INTO scenes VALUES (${key},${scene.sceneId},${scene.startFrame},${scene.endFrame},${scene.startSec},${scene.startSec + scene.durationSec})`;
              }, Effect.mapError(rowsError)),
            } satisfies StageOutput;
          }
          case "detections": {
            const output = yield* objects
              .detect(input.media, cvParams.stride, input.progress)
              .pipe(Effect.mapError(inferenceError));
            return {
              artifact: output.items,
              device: output.device,
              writeRows: Effect.fn("Pipeline.writeRows")(function* (key: StageRunKey) {
                const sql = yield* SqlClient.SqlClient;
                for (const sample of output.items)
                  yield* sql`INSERT INTO samples (stage_run_key,frame_index,time_sec,counts_json) VALUES (${key},${sample.frameIndex},${sample.timeSec},${JSON.stringify(sample.counts)})`;
              }, Effect.mapError(rowsError)),
            } satisfies StageOutput;
          }
          case "windows": {
            const sceneRows = yield* read(input, "scenes", Schema.Array(sceneSchema));
            const sampleRows = yield* read(input, "detections", Schema.Array(sampleSchema));
            const windows = functions.computeWindows(
              sceneRows,
              sampleRows,
              { ...input.media.probe, stride: cvParams.stride },
              input.job.spec.rule,
            );
            return {
              artifact: windows,
              device: null,
              writeRows: Effect.fn("Pipeline.writeRows")(function* (key: StageRunKey) {
                const sql = yield* SqlClient.SqlClient;
                for (const [index, window] of windows.entries())
                  yield* sql`INSERT INTO windows VALUES (${`${key}:${index}`},${key},${window.start},${window.end},${JSON.stringify(window.anchors)})`;
              }, Effect.mapError(rowsError)),
            } satisfies StageOutput;
          }
          case "segments": {
            const windows = yield* read(input, "windows", Schema.Array(windowSchema));
            const windowRun = input.inputs.find((item) => item.stage === "windows");
            if (!windowRun)
              return yield* new JobError({
                stage,
                category: "InvalidInput",
                message: "Missing windows",
              });
            const planned = functions.planSegments(windows, input.job.spec);
            const encoded = yield* Effect.forEach(planned, (segment, index) =>
              clips.encode(input.media, segment.start, segment.end).pipe(
                Effect.mapError(inferenceError),
                Effect.map((clip) => ({
                  ...segment,
                  ...clip,
                  id: `${runKey}:${index}`,
                  windowId: `${windowRun.key}:${segment.windowIndex}`,
                })),
              ),
            );
            return {
              artifact: encoded,
              device: null,
              writeRows: Effect.fn("Pipeline.writeRows")(function* (key: StageRunKey) {
                const sql = yield* SqlClient.SqlClient;
                for (const segment of encoded)
                  yield* sql`INSERT INTO segments VALUES (${segment.id},${key},${segment.windowId},${segment.blob},${segment.clipStart},${segment.durationSec})`;
              }, Effect.mapError(rowsError)),
            } satisfies StageOutput;
          }
          case "verdicts":
            return yield* new JobError({
              stage,
              category: "InvalidInput",
              message: "Verdicts run through LlmStep",
            });
          case "highlights":
            return yield* functions.highlights(input);
        }
      });
      return {
        version: functions.version,
        params: (stage, job) => ({
          config: functions.params(stage, job.spec),
          ...(stage === "scenes" || stage === "detections" ? cvStageParams(stage, provenance) : {}),
          ...(stage === "windows" ? { rule: job.spec.rule } : {}),
          ...(stage === "verdicts"
            ? {
                model: job.spec.llm.model,
                promptVersion: job.spec.llm.promptVersion,
                maxTokens: 4096,
              }
            : {}),
          ...(stage === "highlights" ? { clips: job.spec.clips } : {}),
        }),
        run: execute,
      } satisfies StageLogic["Service"];
    }),
  );
