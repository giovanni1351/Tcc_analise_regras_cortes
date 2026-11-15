import { Schema } from "effect";
import { ClipSeconds, TargetEventClass } from "./domain.ts";

const Confidence = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0),Schema.isLessThanOrEqualTo(1));
const Prediction = {event_class:TargetEventClass,timestamp_seconds:ClipSeconds,confidence:Confidence};
export const LlmVerdict = Schema.Struct({
 segment_kind:Schema.Literals(["Single-highlight","Multi-highlight","Non-highlight"]),
 events:Schema.Array(Schema.Struct({...Prediction,alternate_prediction:Schema.NullOr(Schema.Struct(Prediction))}))
});
export type LlmVerdict = typeof LlmVerdict.Type;
