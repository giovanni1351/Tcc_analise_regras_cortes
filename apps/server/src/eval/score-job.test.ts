import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { Highlight } from "@tcc/contracts";
import { labelsForHalf, scoreHighlights } from "./score-job.ts";

it("scores classes one to one, visibility, window union and ceiling", () => {
  const truth = labelsForHalf(
    {
      annotations: [
        { gameTime: "1 - 01:00", position: "60000", label: "Goal" },
        { gameTime: "1 - 01:05", position: "65000", label: "Shots on target" },
        { gameTime: "1 - 01:10", position: "70000", label: "Foul", visibility: "not shown" },
        { gameTime: "2 - 01:00", position: "60000", label: "Goal" },
        { gameTime: "1 - 02:00", position: "120000", label: "Offside" },
      ],
    },
    1,
  );
  const highlights = ["Goal", "Goal", "Shot off target"].map((c, i) =>
    Schema.decodeUnknownSync(Highlight)({
      id: String(i),
      class: c,
      videoSeconds: 61,
      confidence: 1,
      segmentId: "s",
      attemptId: "a",
      half: 1,
      clipUrl: null,
    }),
  );
  const result = scoreHighlights(
    highlights,
    truth,
    [
      { start: 50, end: 66 },
      { start: 60, end: 80 },
    ],
    150,
  );
  assert.deepStrictEqual(result.overall, {
    tp: 1,
    fp: 2,
    fn: 2,
    precision: 1 / 3,
    recall: 1 / 3,
    f1: 1 / 3,
  });
  assert.strictEqual(result.perClass["Goal"]?.tp, 1);
  assert.strictEqual(result.perClass["Shot on target"]?.fn, 1);
  assert.strictEqual(result.perClass["Shot off target"]?.fp, 1);
  assert.strictEqual(result.perClass["Foul"]?.fn, 0);
  assert.strictEqual(result.ceiling.recall, 2 / 3);
  assert.strictEqual(result.windowShare, 0.2);
  assert.strictEqual(scoreHighlights([], truth, [], 150, true).overall.fn, 4);
});
