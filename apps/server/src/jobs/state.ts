import { Conflict, type JobState, type StageName } from "@tcc/contracts";
import { Effect } from "effect";

export type JobEvent =
  | { readonly _tag: "Create" }
  | { readonly _tag: "Start" }
  | {
      readonly _tag: "Progress";
      readonly stage: StageName;
      readonly done: number;
      readonly total: number;
    }
  | {
      readonly _tag: "Complete";
      readonly state: Extract<JobState, { _tag: "Succeeded" | "Partial" | "Failed" }>;
    }
  | { readonly _tag: "Cancel" }
  | { readonly _tag: "Resume" }
  | { readonly _tag: "Recover" };

export const transition = (state: JobState | null, event: JobEvent): JobState | Conflict => {
  if (state === null && event._tag === "Create") return { _tag: "Queued" };
  if (state?._tag === "Queued" && event._tag === "Start")
    return { _tag: "Running", stage: "probe", done: 0, total: 1 };
  if (state?._tag === "Running") {
    if (
      event._tag === "Progress" &&
      Number.isInteger(event.done) &&
      Number.isInteger(event.total) &&
      event.done >= 0 &&
      event.done <= event.total
    )
      return { _tag: "Running", stage: event.stage, done: event.done, total: event.total };
    if (event._tag === "Complete") return event.state;
    if (event._tag === "Recover") return { _tag: "Queued" };
  }
  if ((state?._tag === "Partial" || state?._tag === "Failed") && event._tag === "Resume")
    return { _tag: "Queued" };
  if (
    (state?._tag === "Queued" || state?._tag === "Running" || state?._tag === "Partial") &&
    event._tag === "Cancel"
  )
    return { _tag: "Cancelled" };
  return new Conflict({
    operation: event._tag,
    message: `Illegal transition from ${state?._tag ?? "absent"}`,
  });
};
export const move = Effect.fn("Jobs.transition")((
  state: JobState | null,
  event: JobEvent,
): Effect.Effect<JobState, Conflict> => {
  const next = transition(state, event);
  return next._tag === "Conflict" ? Effect.fail(next) : Effect.succeed(next);
});
