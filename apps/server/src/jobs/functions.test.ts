import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { Highlight, MediaHash, VideoSeconds } from "@tcc/contracts";
import { pipelineFunctions, mergeOverlaps, toVideoSeconds } from "./functions.ts";

it("merges at encoded bounds and keeps the winning prediction's provenance", () => {
  const seconds = Schema.decodeSync(VideoSeconds);
  const segments = [100, 134].map((start, index) => ({
    id: "segment-" + index,
    windowId: "window",
    windowIndex: 0,
    start: seconds(start + 1),
    end: seconds(start + 41),
    blob: Schema.decodeSync(MediaHash)("a".repeat(64)),
    clipStart: seconds(start),
    durationSec: 40,
  }));
  const predictions = [0.6, 0.9].map((confidence, index) =>
    Schema.decodeSync(Highlight)({
      id: "highlight-" + index,
      class: "Goal",
      half: 1,
      videoSeconds: 134 + index,
      confidence,
      segmentId: segments[index]!.id,
      attemptId: "attempt-" + index,
      clipUrl: null,
    }),
  );
  assert.deepStrictEqual(mergeOverlaps(predictions, segments), [predictions[1]!]);
  assert.strictEqual(toVideoSeconds(seconds(134), 1, 40), 135);
});

it("versions stages independently and fingerprints encoder and overlap merge parameters", () => {
  const names = [
    "probe",
    "scenes",
    "detections",
    "windows",
    "segments",
    "verdicts",
    "highlights",
  ] as const;
  assert.strictEqual(new Set(names.map(pipelineFunctions.version)).size, names.length);
  assert.match(JSON.stringify(pipelineFunctions.params("segments")), /encodeArgsHash/);
  assert.match(JSON.stringify(pipelineFunctions.params("highlights")), /overlapMergeVersion/);
});
