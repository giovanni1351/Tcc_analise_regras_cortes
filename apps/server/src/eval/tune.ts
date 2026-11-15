import { Effect, Schedule, Schema } from "effect";
import { defaultRuleConfig, Segmentation, SourceRef, type JobId } from "@tcc/contracts";
import { EvaluationError, metrics, scoreJob, type EvaluationClient } from "./score-job.ts";
import { studySplit, type StudyHalf } from "./split.ts";

export const tuningSeed = 42;
export function random(seed = tuningSeed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function parseGrid(grid: string) {
  const values = grid.split(",").map((point) => {
    const parts = point.split("/");
    if (parts.length !== 2 || parts.some((p) => !p.trim()))
      throw new Error("Expected maxSec/overlapSec grid points");
    return Schema.decodeSync(Segmentation)({
      maxSec: Number(parts[0]),
      overlapSec: Number(parts[1]),
    });
  });
  if (new Set(values.map(configKey)).size !== values.length)
    throw new Error("Duplicate grid points");
  if (!values.some((s) => configKey(s) === "40/5"))
    throw new Error("Train grid requires the 40/5 baseline");
  return values;
}
export const configKey = (s: Segmentation) => `${s.maxSec}/${s.overlapSec}`;
export function sampleHalves(halves: ReadonlyArray<StudyHalf>, n: number) {
  if (!Number.isInteger(n) || n < 1 || n > halves.length) throw new Error("Invalid --halves");
  const rng = random();
  const shuffled = [...halves].sort((a, b) => a.workbook.localeCompare(b.workbook, "en"));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, n);
}
export function makeTunePlan(options: {
  halves: number;
  model: string;
  grid: string;
  maxUsd: number;
  usdPerCall?: number;
  usdPerSecond: number | null;
}) {
  if (!options.model.trim()) throw new Error("--model is required");
  if (!Number.isFinite(options.maxUsd) || options.maxUsd < 0)
    throw new Error("--max-usd must be nonnegative");
  if (
    options.usdPerCall !== undefined &&
    (!Number.isFinite(options.usdPerCall) || options.usdPerCall < 0)
  )
    throw new Error("--usd-per-call must be nonnegative");
  const free = options.model.endsWith(":free");
  const rate = options.usdPerCall ?? options.usdPerSecond;
  if (!free && (rate === null || !Number.isFinite(rate) || rate <= 0))
    throw new Error("Paid model requires recorded pricing or --usd-per-call > 0");
  const halves = sampleHalves(studySplit.train, options.halves);
  const grid = parseGrid(options.grid);
  const jobs = grid.flatMap((segmentation) =>
    halves.map((half) => {
      const segments =
        Math.ceil(half.duration / (segmentation.maxSec - segmentation.overlapSec)) + half.scenes;
      const estimatedUsd = free
        ? 0
        : options.usdPerCall !== undefined
          ? segments * options.usdPerCall
          : segments * segmentation.maxSec * (options.usdPerSecond ?? 0);
      return { half, segmentation, segments, estimatedUsd };
    }),
  );
  const estimatedUsd = jobs.reduce((sum, j) => sum + j.estimatedUsd, 0);
  return {
    seed: tuningSeed,
    model: options.model,
    maxUsd: options.maxUsd,
    estimatedUsd,
    admitted: estimatedUsd <= options.maxUsd,
    estimate: "upper estimate from study duration and scene count",
    jobs,
  };
}
export type TunePlan = ReturnType<typeof makeTunePlan>;
export const waitForJob = Effect.fn("Evaluation.waitForJob")(function* (
  client: Pick<EvaluationClient, "getJob">,
  id: JobId,
) {
  const job = yield* client.getJob({ params: { id } }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      while: (job) => job.state._tag === "Queued" || job.state._tag === "Running",
    }),
  );
  if (job.state._tag === "Failed" || job.state._tag === "Cancelled")
    return yield* new EvaluationError({ operation: "wait", resource: id, cause: job.state });
  return job;
});
export type ScoredJob = Effect.Success<ReturnType<typeof scoreJob>>;
export function aggregate(scores: ReadonlyArray<ScoredJob>) {
  const totals = scores.reduce(
    (a, s) => ({ tp: a.tp + s.overall.tp, fp: a.fp + s.overall.fp, fn: a.fn + s.overall.fn }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const segments = scores.reduce((n, s) => n + s.coverage.segments, 0);
  return {
    ...metrics(totals),
    costPerHalf: scores.length ? scores.reduce((n, s) => n + s.costUsd, 0) / scores.length : 0,
    invalidRate: segments ? scores.reduce((n, s) => n + s.coverage.invalid, 0) / segments : 0,
  };
}
export function pairedBootstrap(
  scores: ReadonlyArray<ScoredJob>,
  baseline: ReadonlyArray<ScoredJob>,
) {
  if (!scores.length || scores.length !== baseline.length)
    throw new Error("Bootstrap requires paired halves");
  for (let i = 0; i < scores.length; i++)
    if (JSON.stringify(scores[i]!.source) !== JSON.stringify(baseline[i]!.source))
      throw new Error("Bootstrap halves differ");
  const rng = random();
  const differences = Array.from({ length: 10000 }, () => {
    const indexes = Array.from({ length: scores.length }, () => Math.floor(rng() * scores.length));
    return (
      aggregate(indexes.map((i) => scores[i]!)).f1 - aggregate(indexes.map((i) => baseline[i]!)).f1
    );
  }).sort((a, b) => a - b);
  return {
    difference: aggregate(scores).f1 - aggregate(baseline).f1,
    lower: differences[249]!,
    upper: differences[9749]!,
    resamples: 10000,
    seed: tuningSeed,
  };
}
export const runTune = Effect.fn("Evaluation.runTune")(function* (
  client: EvaluationClient,
  plan: TunePlan,
  options: { dryRun: boolean; includeNotShown: boolean },
  save: (report: unknown) => Effect.Effect<void, EvaluationError>,
) {
  if (!plan.admitted)
    return yield* new EvaluationError({
      operation: "admit",
      resource: plan.model,
      cause: `Estimated $${plan.estimatedUsd} exceeds --max-usd ${plan.maxUsd}`,
    });
  if (options.dryRun) return { plan };
  const scored: Array<{ config: string; score: ScoredJob }> = [];
  for (const item of plan.jobs) {
    const ref = yield* Schema.decodeEffect(SourceRef)(item.half);
    const source = yield* client.registerSource({ payload: ref });
    const job = yield* client.createJob({
      payload: {
        sourceId: source.id,
        spec: {
          rule: defaultRuleConfig,
          clips: false,
          segmentation: item.segmentation,
          llm: { model: plan.model, promptVersion: "benchmark-v1", maxCostUsd: item.estimatedUsd },
        },
      },
    });
    yield* save({ plan, scored, pendingJobId: job.id });
    yield* waitForJob(client, job.id);
    scored.push({
      config: configKey(item.segmentation),
      score: yield* scoreJob(client, job.id, options.includeNotShown),
    });
    yield* save({ plan, scored });
  }
  const baseline = scored.filter((s) => s.config === "40/5").map((s) => s.score);
  const configs = [...new Set(scored.map((s) => s.config))].map((config) => {
    const scores = scored.filter((s) => s.config === config).map((s) => s.score);
    return { config, ...aggregate(scores), bootstrap: pairedBootstrap(scores, baseline) };
  });
  return { plan, scored, configs };
});
