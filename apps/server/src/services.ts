import { Context, Schema } from "effect";
import type { Effect, Scope } from "effect";
import type {
  ClipSeconds,
  FrameIndex,
  LlmVerdict,
  MediaHash,
  Probe,
  VideoSeconds,
} from "@tcc/contracts";

export type Device = "cuda" | "coreml" | "cpu";

export interface ProbedMedia {
  readonly path: string;
  readonly hash: MediaHash;
  readonly probe: Probe;
  readonly sourceStat: { readonly size: number; readonly mtimeMs: number };
}

export interface Scene {
  readonly sceneId: number;
  readonly startFrame: FrameIndex;
  readonly endFrame: FrameIndex;
  readonly startSec: VideoSeconds;
  readonly durationSec: number;
}

export interface ClassCounts {
  readonly player: number;
  readonly goalkeeper: number;
  readonly referee: number;
  readonly ball: number;
}

export interface Sample {
  readonly frameIndex: FrameIndex;
  readonly timeSec: VideoSeconds;
  readonly counts: ClassCounts;
}

export interface Detected<A> {
  readonly device: Device;
  readonly items: ReadonlyArray<A>;
}

export interface CandidateWindow {
  readonly start: VideoSeconds;
  readonly end: VideoSeconds;
  readonly anchors: ReadonlyArray<VideoSeconds>;
}

export interface PlannedSegment {
  readonly windowIndex: number;
  readonly start: VideoSeconds;
  readonly end: VideoSeconds;
}

export interface EncodedClip {
  readonly blob: MediaHash;
  readonly clipStart: VideoSeconds;
  readonly durationSec: number;
}

export interface ProviderRequest {
  readonly model: string;
  readonly promptVersion: string;
  readonly clipPath: string;
  readonly maxTokens: number;
}

export interface ProviderReply {
  readonly httpStatus: number;
  readonly body: unknown;
  readonly generationId: string | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export type ParsedVerdict =
  | { readonly _tag: "Valid"; readonly verdict: LlmVerdict }
  | { readonly _tag: "Invalid"; readonly reason: string };

export interface ClipPrediction {
  readonly segmentIndex: number;
  readonly eventClass: LlmVerdict["events"][number]["event_class"];
  readonly t: ClipSeconds;
  readonly confidence: number;
}

export class MediaError extends Schema.TaggedError<MediaError, { readonly brand: unique symbol }>()(
  "MediaError",
  { operation: Schema.String, path: Schema.String, cause: Schema.Defect() },
) {}

export class InferenceError extends Schema.TaggedError<
  InferenceError,
  { readonly brand: unique symbol }
>()("InferenceError", {
  model: Schema.Literals(["transnetv2", "yolo"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ProviderError extends Schema.TaggedError<
  ProviderError,
  { readonly brand: unique symbol }
>()("ProviderError", {
  category: Schema.Literals([
    "RateLimited",
    "InFlightBudget",
    "CreditExhausted",
    "Unauthorized",
    "Moderation",
    "Upstream",
    "Network",
    "Timeout",
  ]),
  httpStatus: Schema.NullOr(Schema.Number),
  retryAfterMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
}) {}

export class MediaProbe extends Context.Service<
  MediaProbe,
  { readonly probe: (path: string) => Effect.Effect<ProbedMedia, MediaError> }
>()("@tcc/server/services/MediaProbe") {}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly tempPath: (ext: string) => Effect.Effect<string, MediaError, Scope.Scope>;
    readonly publish: (tempPath: string, ext: string) => Effect.Effect<MediaHash, MediaError>;
    readonly path: (hash: MediaHash) => Effect.Effect<string, MediaError>;
  }
>()("@tcc/server/services/BlobStore") {}

export class SceneDetector extends Context.Service<
  SceneDetector,
  { readonly detect: (media: ProbedMedia) => Effect.Effect<Detected<Scene>, InferenceError> }
>()("@tcc/server/services/SceneDetector") {}

export class ObjectDetector extends Context.Service<
  ObjectDetector,
  {
    readonly detect: (
      media: ProbedMedia,
      stride: number,
      onProgress: (done: number, total: number) => Effect.Effect<void>,
    ) => Effect.Effect<Detected<Sample>, InferenceError>;
  }
>()("@tcc/server/services/ObjectDetector") {}

export class ClipEncoder extends Context.Service<
  ClipEncoder,
  {
    readonly encode: (
      media: ProbedMedia,
      start: VideoSeconds,
      end: VideoSeconds,
    ) => Effect.Effect<EncodedClip, MediaError>;
  }
>()("@tcc/server/services/ClipEncoder") {}

export class OpenRouter extends Context.Service<
  OpenRouter,
  { readonly complete: (request: ProviderRequest) => Effect.Effect<ProviderReply, ProviderError> }
>()("@tcc/server/services/OpenRouter") {}
