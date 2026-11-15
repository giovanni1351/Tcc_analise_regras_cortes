import { assert, it } from "@effect/vitest";
import { parseStructuredPrediction } from "./rescore-parser.ts";
import { matchAt5 } from "./rescore.ts";
it("preserves benchmark parser rules for missing alternates and segment counts", () => {
  const responseText = JSON.stringify({
    segment_kind: "Single-highlight",
    events: [{ event_class: "Goal", timestamp_seconds: 20, confidence: 0.9 }],
    extra: true,
  });
  const parsed = parseStructuredPrediction({ segmentId: "segment", responseText });
  assert.isTrue(parsed.ok);
  assert.isFalse(
    parseStructuredPrediction({
      segmentId: "segment",
      responseText: '{"segment_kind":"Multi-highlight","events":[]}',
    }).ok,
  );
  assert.isFalse(parseStructuredPrediction({ segmentId: "segment", responseText: "[{}]" }).ok);
});
it("matches by confidence, nearest unused same-class truth, inclusively at five seconds", () => {
  const parsed = parseStructuredPrediction({
    segmentId: "segment",
    responseText: JSON.stringify({
      segment_kind: "Multi-highlight",
      events: [
        { event_class: "Goal", timestamp_seconds: 0, confidence: 0.1 },
        { event_class: "Goal", timestamp_seconds: 4, confidence: 0.9 },
        { event_class: "Foul", timestamp_seconds: 1, confidence: 0.8 },
      ],
    }),
  });
  assert.isTrue(parsed.ok);
  if (!parsed.ok) return;
  const truth = [
    { id: "near", targetClass: "Goal", seconds: 105, visibility: "visible" },
    { id: "far", targetClass: "Goal", seconds: 109, visibility: "visible" },
    { id: "hidden", targetClass: "Foul", seconds: 101, visibility: "not shown" },
  ];
  const result = matchAt5(parsed.value.predictions, truth, 100, false);
  assert.deepStrictEqual(
    result.matches.map((match) => match.truthId),
    ["near", null, null],
  );
  assert.deepStrictEqual([result.tp, result.fp, result.fn], [1, 2, 1]);
  assert.strictEqual(matchAt5(parsed.value.predictions, truth, 100, true).tp, 2);
  assert.strictEqual(
    matchAt5([{ ...parsed.value.predictions[0]!, timestampSeconds: 0 }], [truth[0]!], 100, false)
      .tp,
    1,
  );
});
