import { Schema } from "effect";
import { VideoSeconds } from "@tcc/contracts";
import type { MergeHighlights } from "./highlights.ts";
import type { PipelineFunctions } from "./pipeline.ts";

const seconds = Schema.decodeSync(VideoSeconds);
export const pipelineFunctions = {
  version: () => "stand-in-windows-v1",
  params: (stage) =>
    stage === "windows"
      ? { starts: [0, 40, 80], duration: 20 }
      : stage === "segments"
        ? { maxDuration: 40, overlap: 5 }
        : stage === "verdicts"
          ? { maxTokens: 4096 }
          : {},
  computeWindows: (_scenes, samples) => {
    const end = samples.at(-1)?.timeSec ?? 0;
    return [0, 40, 80]
      .filter((start) => start < end)
      .map((start) => ({
        start: seconds(start),
        end: seconds(Math.min(start + 20, end)),
        anchors: [seconds(start)],
      }));
  },
  planSegments: (windows) =>
    windows.map((window, windowIndex) => ({ windowIndex, start: window.start, end: window.end })),
} satisfies Omit<PipelineFunctions, "highlights">;

export const mergeOverlaps: MergeHighlights = (predictions) => predictions;
export const toVideoSeconds = (start: VideoSeconds, offset: number) => seconds(start + offset);
