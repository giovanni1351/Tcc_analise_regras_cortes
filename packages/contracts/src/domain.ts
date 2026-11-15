import { Schema } from "effect";
import { targetEventClasses } from "./predictionSchema.ts";

export const MediaHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("MediaHash"),
);
export const SourceId = Schema.NonEmptyString.pipe(Schema.brand("SourceId"));
export const JobId = Schema.NonEmptyString.pipe(Schema.brand("JobId"));
export const StageRunKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("StageRunKey"),
);
export const SegmentId = Schema.NonEmptyString.pipe(Schema.brand("SegmentId"));
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export const HighlightId = Schema.NonEmptyString.pipe(Schema.brand("HighlightId"));
export const NonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const Count = NonNegative.check(Schema.isInt());
export const VideoSeconds = NonNegative.pipe(Schema.brand("VideoSeconds"));
export const ClipSeconds = NonNegative.pipe(Schema.brand("ClipSeconds"));
export const FrameIndex = Count.pipe(Schema.brand("FrameIndex"));
export type MediaHash = typeof MediaHash.Type;
export type SourceId = typeof SourceId.Type;
export type JobId = typeof JobId.Type;
export type StageRunKey = typeof StageRunKey.Type;
export type SegmentId = typeof SegmentId.Type;
export type AttemptId = typeof AttemptId.Type;
export type HighlightId = typeof HighlightId.Type;
export type VideoSeconds = typeof VideoSeconds.Type;
export type ClipSeconds = typeof ClipSeconds.Type;
export type FrameIndex = typeof FrameIndex.Type;

export const Half = Schema.Literals([1, 2]);
export const SourceRef = Schema.Union([
  Schema.TaggedStruct("LocalFile", { path: Schema.NonEmptyString }),
  Schema.TaggedStruct("SoccerNetHalf", {
    league: Schema.NonEmptyString,
    season: Schema.NonEmptyString,
    game: Schema.NonEmptyString,
    half: Half,
    resolution: Schema.Literals(["224p", "720p"]),
  }),
]);
const commonRule = { short: NonNegative, cluster: Count, before: NonNegative, after: NonNegative };
const Fraction = NonNegative.check(Schema.isLessThanOrEqualTo(1));
export const RuleConfig = Schema.Union([
  Schema.TaggedStruct("Zero", {
    ...commonRule,
    zero: Fraction,
    preceding: Schema.Boolean,
    use_zero: Schema.Boolean,
  }),
  Schema.TaggedStruct("Context", {
    ...commonRule,
    min_previous: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
    drop_fraction: Fraction,
  }),
]).check(Schema.makeFilter((r) => r.before + r.after > 0 || "before + after must be positive"));
export type RuleConfig = typeof RuleConfig.Type;
export const defaultRuleConfig = {
  _tag: "Zero",
  short: 25,
  zero: 0,
  cluster: 1,
  preceding: true,
  use_zero: true,
  before: 10,
  after: 16,
} satisfies RuleConfig;
export const JobSpec = Schema.Struct({
  rule: RuleConfig,
  llm: Schema.Struct({
    model: Schema.NonEmptyString,
    promptVersion: Schema.NonEmptyString,
    maxCostUsd: NonNegative,
  }),
  clips: Schema.Boolean,
});
export type JobSpec = typeof JobSpec.Type;
export const StageName = Schema.Literals([
  "probe",
  "scenes",
  "detections",
  "windows",
  "segments",
  "verdicts",
  "highlights",
]);
export const Coverage = Schema.Struct({
  segments: Count,
  valid: Count,
  invalid: Count,
  ambiguous: Count,
  notSent: Count,
});
export const PartialReason = Schema.Union([
  Schema.TaggedStruct("FreeDailyLimit", { retryAfterMs: NonNegative }),
  Schema.TaggedStruct("BudgetExceeded", { capUsd: NonNegative, committedUsd: NonNegative }),
  Schema.TaggedStruct("AmbiguousAttempts", { count: Count }),
]);
export class JobError extends Schema.TaggedError<JobError, { readonly brand: unique symbol }>()(
  "JobError",
  {
    stage: StageName,
    category: Schema.Literals([
      "SourceChanged",
      "Inference",
      "Process",
      "Provider",
      "Persistence",
      "InvalidInput",
    ]),
    message: Schema.String,
  },
) {}
export const JobState = Schema.Union([
  Schema.TaggedStruct("Queued", {}),
  Schema.TaggedStruct("Running", { stage: StageName, done: Count, total: Count }),
  Schema.TaggedStruct("Succeeded", { coverage: Coverage }),
  Schema.TaggedStruct("Partial", { coverage: Coverage, reason: PartialReason }),
  Schema.TaggedStruct("Failed", { stage: StageName, error: JobError }),
  Schema.TaggedStruct("Cancelled", {}),
]);
export const TargetEventClass = Schema.Literals(targetEventClasses);
export const Highlight = Schema.Struct({
  id: HighlightId,
  class: TargetEventClass,
  half: Schema.NullOr(Half),
  videoSeconds: VideoSeconds,
  confidence: Fraction,
  segmentId: SegmentId,
  attemptId: AttemptId,
  clipUrl: Schema.NullOr(Schema.String),
});
export const JobResult = Schema.Struct({
  jobId: JobId,
  highlights: Schema.Array(Highlight),
  coverage: Coverage,
});
export const Budget = Schema.Struct({
  limitUsd: NonNegative,
  committedUsd: NonNegative,
  reservedUsd: NonNegative,
  ambiguousUsd: NonNegative,
});
export type Budget = typeof Budget.Type;
export const Probe = Schema.Struct({
  duration: VideoSeconds,
  fps: NonNegative,
  size: Count,
  frameCount: Count,
});
export const Source = Schema.Struct({
  id: SourceId,
  ref: SourceRef,
  mediaHash: MediaHash,
  probe: Probe,
});
export const StageProgress = Schema.Struct({
  stage: StageName,
  key: StageRunKey,
  done: Count,
  total: Count,
  device: Schema.NullOr(Schema.String),
});
export const Job = Schema.Struct({
  id: JobId,
  sourceId: SourceId,
  spec: JobSpec,
  state: JobState,
  stages: Schema.Array(StageProgress),
  coverage: Coverage,
  committedUsd: NonNegative,
  reservedUsd: NonNegative,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type Half = typeof Half.Type;
export type SourceRef = typeof SourceRef.Type;
export type StageName = typeof StageName.Type;
export type Coverage = typeof Coverage.Type;
export type PartialReason = typeof PartialReason.Type;
export type JobState = typeof JobState.Type;
export type TargetEventClass = typeof TargetEventClass.Type;
export type Highlight = typeof Highlight.Type;
export type JobResult = typeof JobResult.Type;
export type Probe = typeof Probe.Type;
export type Source = typeof Source.Type;
export type StageProgress = typeof StageProgress.Type;
export type Job = typeof Job.Type;
