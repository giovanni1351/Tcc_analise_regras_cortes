import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  AttemptId,
  HighlightId,
  JobError,
  LlmVerdict,
  SegmentId,
  VideoSeconds,
  type Highlight,
} from "@tcc/contracts";
import { Repository, newId } from "./repository.ts";
import { segmentArtifact } from "./pipeline.ts";
import type { StageInput, StageOutput } from "./stages.ts";

export type MergeHighlights = (
  predictions: ReadonlyArray<Highlight>,
  segments: typeof segmentArtifact.Type,
) => ReadonlyArray<Highlight>;
export const makeHighlightStage = Effect.fn("Highlights.make")(function* (
  merge: MergeHighlights,
  toVideoSeconds: (start: VideoSeconds, offset: number, duration: number) => VideoSeconds,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* Repository;
  return Effect.fn("Highlights.run")(
    function* (input: StageInput) {
      const artifact = input.inputs.find((item) => item.stage === "segments");
      if (!artifact)
        return yield* new JobError({
          stage: "highlights",
          category: "InvalidInput",
          message: "Missing segments artifact",
        });
      const text = yield* fs.readFileString(artifact.artifactPath);
      const segments = yield* Schema.decodeEffect(Schema.fromJsonString(segmentArtifact))(text);
      const source = yield* repo.source(input.job.sourceId);
      const rows =
        yield* sql`SELECT a.id,s.id AS segment_id,a.verdict_json FROM segments s JOIN llm_attempts a ON a.id=(SELECT candidate.id FROM llm_attempts candidate JOIN segments encoded ON encoded.id=candidate.segment_id WHERE candidate.state='Answered' AND candidate.model=${input.job.spec.llm.model} AND candidate.prompt_version=${input.job.spec.llm.promptVersion} AND encoded.blob_hash=s.blob_hash AND candidate.inference_json='{"maxTokens":4096}'  ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT 1) WHERE s.stage_run_key=${artifact.key} AND a.verdict_json IS NOT NULL`;
      const attempts = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ id: AttemptId, segment_id: SegmentId, verdict_json: Schema.String }),
        ),
      )(rows);
      const predictions: Array<Highlight> = [];
      for (const attempt of attempts) {
        const segment = segments.find((segment) => segment.id === attempt.segment_id);
        if (!segment) continue;
        const verdict = yield* Schema.decodeEffect(Schema.fromJsonString(LlmVerdict))(
          attempt.verdict_json,
        );
        for (const event of verdict.events) {
          if (event.timestamp_seconds > segment.durationSec)
            return yield* new JobError({
              stage: "highlights",
              category: "InvalidInput",
              message: "Stored verdict exceeds clip duration",
            });
          predictions.push({
            id: yield* newId.pipe(Effect.flatMap(Schema.decodeEffect(HighlightId))),
            class: event.event_class,
            half: source.ref._tag === "SoccerNetHalf" ? source.ref.half : null,
            videoSeconds: yield* Schema.decodeEffect(VideoSeconds)(
              toVideoSeconds(segment.clipStart, event.timestamp_seconds, segment.durationSec),
            ),
            confidence: event.confidence,
            segmentId: yield* Schema.decodeEffect(SegmentId)(segment.id),
            attemptId: attempt.id,
            clipUrl: input.job.spec.clips ? `/blobs/${segment.blob}` : null,
          });
        }
      }
      const highlights = merge(predictions, segments);
      return {
        artifact: highlights,
        device: null,
        writeRows: Effect.fn("Highlights.writeRows")(
          function* () {
            yield* sql`DELETE FROM highlights WHERE job_id=${input.job.id}`;
            for (const highlight of highlights) {
              const segment = segments.find((segment) => segment.id === highlight.segmentId);
              yield* sql`INSERT INTO highlights VALUES (${highlight.id},${input.job.id},${highlight.class},${highlight.half},${highlight.videoSeconds},${highlight.confidence},${highlight.segmentId},${highlight.attemptId},${highlight.clipUrl ? (segment?.blob ?? null) : null})`;
            }
          },
          Effect.mapError(
            (cause) =>
              new JobError({
                stage: "highlights",
                category: "Persistence",
                message: String(cause),
              }),
          ),
        ),
      } satisfies StageOutput;
    },
    Effect.mapError((cause) =>
      Schema.is(JobError)(cause)
        ? cause
        : new JobError({ stage: "highlights", category: "Persistence", message: String(cause) }),
    ),
  );
});
