import { Option, Schema } from "effect";
import { ClipSeconds, VideoSeconds } from "@tcc/contracts";
import { computeWindows } from "../domain/rules.ts";
import {
  planSegments,
  mergeOverlaps as mergePredictions,
  toVideoSeconds as mapTime,
} from "../domain/segments.ts";
import { encodeArgsHash } from "../media/index.ts";
import type { MergeHighlights } from "./highlights.ts";
import type { PipelineFunctions } from "./pipeline.ts";

export const pipelineFunctions = {
  version: (stage) =>
    ({
      probe: "probe-v1",
      scenes: "scenes-v1",
      detections: "detections-v1",
      windows: "rules-c-v1",
      segments: "segments-v1",
      verdicts: "verdicts-v1",
      highlights: "highlights-v1",
    })[stage],
  params: (stage) =>
    stage === "segments"
      ? { maxSec: 40, overlapSec: 5, encodeArgsHash }
      : stage === "highlights"
        ? { overlapMergeVersion: "nearest-v1" }
        : {},
  computeWindows,
  planSegments: (windows) => planSegments(windows, { maxSec: 40, overlapSec: 5 }),
} satisfies Omit<PipelineFunctions, "highlights">;

export const mergeOverlaps: MergeHighlights = (predictions, segments) => {
  const bounds = segments.map((segment) => ({
    windowIndex: segment.windowIndex,
    start: segment.clipStart,
    end: Schema.decodeSync(VideoSeconds)(segment.clipStart + segment.durationSec),
  }));
  const mapped = predictions.map((prediction) => {
    const segmentIndex = segments.findIndex((segment) => segment.id === prediction.segmentId);
    return {
      segmentIndex,
      eventClass: prediction.class,
      t: Schema.decodeSync(ClipSeconds)(
        prediction.videoSeconds - segments[segmentIndex]!.clipStart,
      ),
      confidence: prediction.confidence,
    };
  });
  return mergePredictions(mapped, bounds).map((merged) => {
    const original = merged.predictionIndices.find(
      (index) => mapped[index]!.segmentIndex === merged.segmentIndex,
    )!;
    return { ...predictions[original]!, videoSeconds: merged.videoSeconds };
  });
};
export const toVideoSeconds = (start: VideoSeconds, offset: number, duration: number) =>
  Option.getOrThrow(mapTime(start, offset, duration));
