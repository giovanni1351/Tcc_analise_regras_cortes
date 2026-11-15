import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  Api,
  JobId,
  NonNegative,
  targetEventClasses,
  type TargetEventClass,
  type Highlight,
} from "@tcc/contracts";
import { matchAt5, type Truth } from "./rescore.ts";

export class EvaluationError extends Schema.TaggedError<
  EvaluationError,
  { readonly brand: unique symbol }
>()("EvaluationError", {
  operation: Schema.String,
  resource: Schema.String,
  cause: Schema.Defect(),
}) {}
export const makeEvaluationClient = (port: number) =>
  HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });
export type EvaluationClient = Effect.Success<
  ReturnType<typeof makeEvaluationClient>
>["highlights"];
export const Labels = Schema.Struct({
  annotations: Schema.Array(
    Schema.Struct({
      gameTime: Schema.String,
      position: Schema.String,
      label: Schema.String,
      visibility: Schema.optionalKey(Schema.String),
    }),
  ),
});
export function normalizeTargetEventClass(label: string): TargetEventClass | null {
  const value = label
    .trim()
    .toLowerCase()
    .replace(/^shots /, "shot ");
  return targetEventClasses.find((c) => c.toLowerCase() === value) ?? null;
}
export function labelsForHalf(labels: typeof Labels.Type, half: 1 | 2): Truth[] {
  return labels.annotations.flatMap((a, index) => {
    const match = /^([12])\s*-\s*\d{1,3}:\d{2}$/.exec(a.gameTime.trim());
    if (!match || Number(match[1]) !== half) return [];
    const seconds = Schema.decodeSync(NonNegative)(Number(a.position) / 1000);
    return [
      {
        id: String(index),
        targetClass: normalizeTargetEventClass(a.label),
        seconds,
        visibility: a.visibility?.trim().toLowerCase() === "not shown" ? "not shown" : "visible",
      },
    ];
  });
}
export function metrics(counts: { tp: number; fp: number; fn: number }) {
  const { tp, fp, fn } = counts;
  return {
    ...counts,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0,
  };
}
export function scoreHighlights(
  highlights: ReadonlyArray<
    Pick<Highlight, "id" | "class" | "videoSeconds" | "confidence" | "segmentId">
  >,
  truth: ReadonlyArray<Truth>,
  windows: ReadonlyArray<{ start: number; end: number }>,
  duration: number,
  includeNotShown = false,
) {
  const labels = truth.filter(
    (t) => t.targetClass !== null && (includeNotShown || t.visibility !== "not shown"),
  );
  const predictions = highlights.map((h) => ({
    id: h.id,
    segmentId: h.segmentId,
    targetClass: h.class,
    timestampSeconds: h.videoSeconds,
    confidence: h.confidence,
    alternatePrediction: null,
  }));
  const score = (c?: string) => {
    const matched = matchAt5(
      predictions.filter((p) => !c || p.targetClass === c),
      labels.filter((t) => !c || t.targetClass === c),
      0,
      true,
    );
    return metrics({ tp: matched.tp, fp: matched.fp, fn: matched.fn });
  };
  let covered = 0;
  let end = 0;
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    const hi = Math.min(duration, window.end);
    covered += Math.max(0, hi - Math.max(end, window.start, 0));
    end = Math.max(end, hi);
  }
  const reachable = labels.filter((t) =>
    windows.some((w) => t.seconds >= w.start && t.seconds <= w.end),
  ).length;
  return {
    overall: score(),
    perClass: Object.fromEntries(targetEventClasses.map((c) => [c, score(c)])),
    windowShare: duration ? covered / duration : 0,
    ceiling: {
      labels: labels.length,
      reachable,
      recall: labels.length ? reachable / labels.length : 0,
    },
  };
}
export const scoreJob = Effect.fn("Evaluation.scoreJob")(function* (
  client: EvaluationClient,
  id: JobId,
  includeNotShown = false,
) {
  const job = yield* client.getJob({ params: { id } });
  if (job.state._tag !== "Succeeded" && job.state._tag !== "Partial")
    return yield* new EvaluationError({
      operation: "score",
      resource: id,
      cause: "Job must be Succeeded or Partial",
    });
  const source = yield* client.getSource({ params: { id: job.sourceId } });
  if (source.ref._tag !== "SoccerNetHalf")
    return yield* new EvaluationError({
      operation: "score",
      resource: id,
      cause: "Expected SoccerNetHalf",
    });
  const root = yield* Config.String("TCC_SOCCERNET_ROOT").pipe(
    Config.withDefault("/home/pedro/tcc/benchmark/downloads"),
  );
  const path = yield* Path.Path;
  const filename = path.join(
    root,
    source.ref.league,
    source.ref.season,
    source.ref.game,
    "Labels-v2.json",
  );
  const fs = yield* FileSystem.FileSystem;
  const labels = yield* Schema.decodeEffect(Schema.fromJsonString(Labels))(
    yield* fs.readFileString(filename),
  );
  const half = source.ref.half;
  const truth = yield* Effect.try({
    try: () => labelsForHalf(labels, half),
    catch: (cause) => new EvaluationError({ operation: "labels", resource: filename, cause }),
  });
  const result = yield* client.getResult({ params: { id } });
  const context = yield* client.evaluationContext({ params: { id } });
  return {
    jobId: id,
    source: source.ref,
    includeNotShown,
    ...scoreHighlights(
      result.highlights,
      truth,
      context.windows,
      source.probe.duration,
      includeNotShown,
    ),
    coverage: result.coverage,
    costUsd: job.committedUsd,
  };
});
