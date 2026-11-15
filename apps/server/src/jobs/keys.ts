import { Effect, Schema } from "effect";
import { StageRunKey } from "@tcc/contracts";

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value)))
      throw new TypeError("Value is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
};
export const stageKey = Effect.fn("Stages.key")(function* (
  stage: string,
  version: string,
  params: unknown,
  inputKeys: ReadonlyArray<string>,
) {
  const bytes = new TextEncoder().encode(canonicalJson({ stage, version, params, inputKeys }));
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
  return yield* Schema.decodeEffect(StageRunKey)(
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
});
