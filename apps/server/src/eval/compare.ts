import { Schema } from "effect";
import { targetEventClasses } from "@tcc/contracts";
import { parseStructuredPrediction } from "./rescore-parser.ts";
import { matchAt5 } from "./rescore.ts";

export const baselineModel = "google/gemini-3.1-flash-lite";
export const comparisonModel = "z-ai/glm-5.3-flash";
export const comparisonSeed = 11011;
export const BenchmarkRow = Schema.Struct({
  run_id: Schema.String,
  segment_id: Schema.String,
  response_text: Schema.String,
  start_seconds: Schema.Number,
  end_seconds: Schema.Number,
  source_video_path: Schema.String,
  selection_stratum: Schema.String,
  target_events_json: Schema.String,
  include_hidden: Schema.Number,
  cost_usd: Schema.NullOr(Schema.Number),
});
export type BenchmarkRow = typeof BenchmarkRow.Type;
export const Truth = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    targetClass: Schema.NullOr(Schema.String),
    seconds: Schema.Number,
    visibility: Schema.String,
  }),
);
export class ComparisonError extends Schema.TaggedError<
  ComparisonError,
  { readonly brand: unique symbol }
>()("ComparisonError", {
  operation: Schema.String,
  resource: Schema.String,
  cause: Schema.Defect(),
}) {}

export function randomSequence(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function selectStratified(
  rows: ReadonlyArray<BenchmarkRow>,
  n = 100,
  seed = comparisonSeed,
) {
  const random = randomSequence(seed);
  const groups = new Map<string, BenchmarkRow[]>();
  for (const row of [...rows].sort((a, b) => a.segment_id.localeCompare(b.segment_id))) {
    const group = groups.get(row.selection_stratum) ?? [];
    group.push(row);
    groups.set(row.selection_stratum, group);
  }
  if (!Number.isInteger(n) || n < groups.size || n > rows.length || groups.size === 0)
    throw new RangeError(`Sample size must be between ${groups.size} and ${rows.length}`);
  const strata = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, group] of strata) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const left = group[i];
      const right = group[j];
      if (left && right) {
        group[i] = right;
        group[j] = left;
      }
    }
  }
  const selected: BenchmarkRow[] = [];
  while (selected.length < n) {
    for (const [, group] of strata) {
      const row = group.pop();
      if (row) selected.push(row);
      if (selected.length === n) break;
    }
  }
  return selected;
}

export type Counts = { tp: number; fp: number; fn: number };
export function metrics(counts: Counts) {
  return {
    ...counts,
    precision: counts.tp / (counts.tp + counts.fp) || 0,
    recall: counts.tp / (counts.tp + counts.fn) || 0,
    f1: (2 * counts.tp) / (2 * counts.tp + counts.fp + counts.fn) || 0,
  };
}
export function aggregate(scores: ReadonlyArray<Counts>) {
  return metrics(
    scores.reduce((sum, s) => ({ tp: sum.tp + s.tp, fp: sum.fp + s.fp, fn: sum.fn + s.fn }), {
      tp: 0,
      fp: 0,
      fn: 0,
    }),
  );
}
export function scoreSegment(row: BenchmarkRow, responseText: string | null) {
  const truth = Schema.decodeSync(Schema.fromJsonString(Truth))(row.target_events_json);
  const parsed = parseStructuredPrediction({
    segmentId: row.segment_id,
    responseText: responseText ?? "",
  });
  const predictions = parsed.ok ? parsed.value.predictions : [];
  const score = (eventClass?: string) => {
    const { tp, fp, fn } = matchAt5(
      eventClass ? predictions.filter((p) => p.targetClass === eventClass) : predictions,
      eventClass ? truth.filter((t) => t.targetClass === eventClass) : truth,
      row.start_seconds,
      row.include_hidden !== 0,
    );
    return { tp, fp, fn };
  };
  return {
    valid: parsed.ok,
    ...score(),
    perClass: Object.fromEntries(targetEventClasses.map((c) => [c, score(c)])),
  };
}
export function pairedBootstrap(
  pairs: ReadonlyArray<{ glm: Counts; baseline: Counts }>,
  resamples = 10_000,
  seed = comparisonSeed,
) {
  if (!pairs.length || resamples < 1 || !Number.isInteger(resamples))
    throw new RangeError("Empty bootstrap or invalid resample count");
  const random = randomSequence(seed);
  const deltas: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sampled = Array.from(
      { length: pairs.length },
      () => pairs[Math.floor(random() * pairs.length)],
    ).filter((p) => p !== undefined);
    deltas.push(
      aggregate(sampled.map((p) => p.glm)).f1 - aggregate(sampled.map((p) => p.baseline)).f1,
    );
  }
  deltas.sort((a, b) => a - b);
  return {
    deltaF1: aggregate(pairs.map((p) => p.glm)).f1 - aggregate(pairs.map((p) => p.baseline)).f1,
    lower: deltas[Math.floor(0.025 * (resamples - 1))],
    upper: deltas[Math.ceil(0.975 * (resamples - 1))],
    resamples,
    seed,
  };
}
