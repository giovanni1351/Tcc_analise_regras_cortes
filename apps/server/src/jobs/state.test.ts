import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Conflict, JobError, type JobState } from "@tcc/contracts";
import { transition, type JobEvent } from "./state.ts";
import { stageKey } from "./keys.ts";
const emptyCoverage = { segments: 0, valid: 0, invalid: 0, ambiguous: 0, notSent: 0 };

it.effect("state/event matrix accepts only legal moves", () =>
  Effect.sync(() => {
    const states: Array<JobState | null> = [
      null,
      { _tag: "Queued" },
      { _tag: "Running", stage: "probe", done: 0, total: 1 },
      { _tag: "Partial", coverage: emptyCoverage, reason: { _tag: "AmbiguousAttempts", count: 1 } },
      { _tag: "Succeeded", coverage: emptyCoverage },
      {
        _tag: "Failed",
        stage: "probe",
        error: new JobError({ stage: "probe", category: "Inference", message: "failed" }),
      },
      { _tag: "Cancelled" },
    ];
    const events: Array<JobEvent> = [
      { _tag: "Create" },
      { _tag: "Start" },
      { _tag: "Progress", stage: "scenes", done: 1, total: 1 },
      { _tag: "Complete", state: { _tag: "Succeeded", coverage: emptyCoverage } },
      {
        _tag: "Complete",
        state: {
          _tag: "Partial",
          coverage: emptyCoverage,
          reason: { _tag: "AmbiguousAttempts", count: 1 },
        },
      },
      {
        _tag: "Complete",
        state: {
          _tag: "Failed",
          stage: "probe",
          error: new JobError({ stage: "probe", category: "Inference", message: "failed" }),
        },
      },
      { _tag: "Cancel" },
      { _tag: "Resume" },
      { _tag: "Recover" },
    ];
    const allowed = [
      ["Create"],
      ["Start", "Cancel"],
      ["Progress", "Complete", "Cancel", "Recover"],
      ["Cancel", "Resume"],
      [],
      ["Resume"],
      [],
    ];
    for (const [index, state] of states.entries())
      for (const event of events)
        assert.strictEqual(
          Schema.is(Conflict)(transition(state, event)),
          !allowed[index]?.includes(event._tag),
          `${state?._tag} / ${event._tag}`,
        );
    assert.strictEqual(
      transition(states[2] ?? null, { _tag: "Progress", stage: "probe", done: 2, total: 1 })._tag,
      "Conflict",
    );
  }),
);

it.effect("stage keys canonicalize nested keys and distinguish inputs and parameters", () =>
  Effect.gen(function* () {
    const key = yield* stageKey("scenes", "v1", { b: 2, a: { d: 4, c: 3 } }, ["media"]);
    assert.strictEqual(
      key,
      yield* stageKey("scenes", "v1", { a: { c: 3, d: 4 }, b: 2 }, ["media"]),
    );
    assert.notStrictEqual(key, yield* stageKey("scenes", "v2", { a: 1 }, ["media"]));
    assert.notStrictEqual(
      key,
      yield* stageKey("scenes", "v1", { b: 2, a: { d: 4, c: 3 } }, ["other"]),
    );
  }),
);
