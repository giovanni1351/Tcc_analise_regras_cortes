import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { JobSpec, Segmentation } from "@tcc/contracts";
import { defaultSpec } from "./repository.ts";
import { stageKey } from "./keys.ts";
import { pipelineFunctions } from "./functions.ts";

it.effect("decoding legacy specs preserves their hash and uses 40/5", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeEffect(JobSpec)(defaultSpec);
    assert.deepStrictEqual(decoded, defaultSpec);
    assert.strictEqual(
      yield* stageKey("spec", "1", decoded, []),
      yield* stageKey("spec", "1", defaultSpec, []),
    );
    assert.deepStrictEqual(
      pipelineFunctions.params("segments", decoded),
      pipelineFunctions.params("segments", {
        ...decoded,
        segmentation: { maxSec: 40, overlapSec: 5 },
      }),
    );
    for (const stage of ["scenes", "detections", "windows", "segments"] as const) {
      const a = yield* stageKey(
        stage,
        pipelineFunctions.version(stage),
        pipelineFunctions.params(stage, decoded),
        [],
      );
      const b = yield* stageKey(
        stage,
        pipelineFunctions.version(stage),
        pipelineFunctions.params(stage, {
          ...decoded,
          segmentation: { maxSec: 20, overlapSec: 4 },
        }),
        [],
      );
      assert.strictEqual(a === b, stage !== "segments");
    }
  }),
);
it("rejects invalid segmentation", () => {
  for (const value of [
    { maxSec: 9, overlapSec: 0 },
    { maxSec: 121, overlapSec: 5 },
    { maxSec: 10, overlapSec: 5 },
    { maxSec: 40, overlapSec: -1 },
  ])
    assert.throws(() => Schema.decodeSync(Segmentation)(value));
});
