import { expect, it } from "vitest";
import { Option, Schema } from "effect";
import { ClipSeconds, VideoSeconds } from "@tcc/contracts";
import { mergeOverlaps, planSegments, toVideoSeconds } from "./segments.ts";
import type { ClipPrediction, PlannedSegment } from "../services.ts";
const sec = Schema.decodeUnknownSync(VideoSeconds);
const clipSec = Schema.decodeUnknownSync(ClipSeconds);
const segment = (start: number, end: number, windowIndex = 0): PlannedSegment => ({
  start: sec(start),
  end: sec(end),
  windowIndex,
});
const prediction = (
  segmentIndex: number,
  t: number,
  confidence = 0.8,
  eventClass: ClipPrediction["eventClass"] = "Goal",
): ClipPrediction => ({ segmentIndex, t: clipSec(t), confidence, eventClass });
it.each([
  [20, [[0, 20]]],
  [40, [[0, 40]]],
  [
    80,
    [
      [0, 40],
      [35, 75],
      [70, 80],
    ],
  ],
])("plans %s seconds", (end, spans) => {
  expect(planSegments([{ start: sec(0), end: sec(end), anchors: [] }])).toEqual(
    spans.map(([a, b]) => segment(a!, b!)),
  );
});
it.each([-1, NaN, Infinity, 41])("rejects invalid clip time %s", (t) =>
  expect(Option.isNone(toVideoSeconds(sec(200), t, 40))).toBe(true),
);
it.each([0, 40])("maps inclusive clip time %s using actual start", (t) =>
  expect(toVideoSeconds(sec(200.12), t, 40)).toEqual(Option.some(sec(200.12 + t))),
);
it.each([
  {
    name: "nearest pair",
    segments: [segment(0, 40), segment(35, 75)],
    predictions: [prediction(0, 36), prediction(0, 39), prediction(1, 3.9)],
    groups: [[0], [1, 2]],
  },
  {
    name: "different class",
    segments: [segment(0, 40), segment(35, 75)],
    predictions: [prediction(0, 36), prediction(1, 1, 0.8, "Foul")],
    groups: [[0], [1]],
  },
  {
    name: "different window",
    segments: [segment(0, 40), segment(35, 75, 1)],
    predictions: [prediction(0, 36), prediction(1, 1)],
    groups: [[0], [1]],
  },
  {
    name: "outside overlap",
    segments: [segment(0, 40), segment(35, 75)],
    predictions: [prediction(0, 34), prediction(1, 1)],
    groups: [[0], [1]],
  },
  {
    name: "chain stays two highlights",
    segments: [segment(0, 40), segment(35, 75), segment(38, 78)],
    predictions: [prediction(0, 39), prediction(1, 4), prediction(2, 1)],
    groups: [[0, 1], [2]],
  },
])("merges $name", ({ segments, predictions, groups }) => {
  expect(mergeOverlaps(predictions, segments).map((p) => p.predictionIndices)).toEqual(groups);
});
it("chooses higher confidence then earlier segment, deterministically", () => {
  const segments = [segment(0, 40), segment(35, 75)];
  expect(
    mergeOverlaps([prediction(0, 36, 0.7), prediction(1, 1, 0.9)], segments)[0]?.segmentIndex,
  ).toBe(1);
  expect(mergeOverlaps([prediction(0, 36), prediction(1, 1)], segments)[0]?.segmentIndex).toBe(0);
});
