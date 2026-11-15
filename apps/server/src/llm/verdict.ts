import { LlmVerdict } from "@tcc/contracts";
import { Schema } from "effect";
import type { ParsedVerdict, ProviderReply } from "../services.ts";

export const Envelope = Schema.Struct({
  id: Schema.optional(Schema.String),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        message: Schema.optional(
          Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }),
        ),
      }),
    ),
  ),
  usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.NullOr(Schema.Number)) })),
});

export function parseVerdict(reply: ProviderReply, clipDuration: number): ParsedVerdict {
  try {
    const envelope = Schema.decodeUnknownSync(Envelope)(reply.body);
    const choice = envelope.choices?.[0];
    if (reply.httpStatus !== 200) return { _tag: "Invalid", reason: "HTTP error" };
    if (choice?.finish_reason === "length")
      return { _tag: "Invalid", reason: "Truncated completion" };
    const content = choice?.message?.content;
    if (!content?.trim()) return { _tag: "Invalid", reason: "Empty content" };
    const verdict = Schema.decodeUnknownSync(LlmVerdict, { onExcessProperty: "error" })(
      JSON.parse(content),
    );
    const expected =
      verdict.events.length === 0
        ? "Non-highlight"
        : verdict.events.length === 1
          ? "Single-highlight"
          : "Multi-highlight";
    if (verdict.segment_kind !== expected)
      return { _tag: "Invalid", reason: "Inconsistent segment_kind" };
    if (
      !Number.isFinite(clipDuration) ||
      clipDuration < 0 ||
      verdict.events.some(
        (event) =>
          event.timestamp_seconds > clipDuration ||
          (event.alternate_prediction !== null &&
            event.alternate_prediction.timestamp_seconds > clipDuration),
      )
    ) {
      return { _tag: "Invalid", reason: "Timestamp outside clip" };
    }
    return { _tag: "Valid", verdict };
  } catch (cause) {
    return { _tag: "Invalid", reason: String(cause) };
  }
}
