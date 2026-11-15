import { parseArgs } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { NonNegative, targetEventClasses } from "@tcc/contracts";
import { databaseLayer } from "../database.ts";
import { acquireDataDirectoryLock } from "../lock.ts";
import { blobStoreLayer, mediaProbeLayer } from "../media/index.ts";
import { processLayer } from "../process.ts";
import { repositoryLayer } from "../jobs/repository.ts";
import { llmStepLayer } from "../jobs/llm.ts";
import { attemptLedgerLayer } from "../llm/ledger.ts";
import { openRouterLayer } from "../llm/openrouter.ts";
import { persistedFreeModelLimiterLayer } from "../llm/limiter.ts";
import {
  BenchmarkRow,
  ComparisonError,
  baselineModel,
  comparisonModel,
  comparisonSeed,
  selectStratified,
  Truth,
} from "./compare.ts";
import { Comparison, comparisonLayer } from "./compare-run.ts";

const main = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          db: {
            type: "string",
            default: "/home/pedro/tcc/benchmark/.scratch/openrouter-720p-top3-budget1000.sqlite",
          },
          run: { type: "string" },
          n: { type: "string", default: "100" },
          out: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          "retry-ambiguous": { type: "boolean", default: false },
          "video-from": { type: "string", default: "/home/pedro/soccernet/downloads" },
          "video-root": { type: "string", default: "/home/pedro/tcc/benchmark/downloads" },
        },
      }),
    catch: (cause) => new ComparisonError({ operation: "arguments", resource: "argv", cause }),
  });
  if (!values.out)
    return yield* new ComparisonError({
      operation: "arguments",
      resource: "--out",
      cause:
        "Required: --out <report.json> [--n 100] [--dry-run] [--retry-ambiguous] [--db <sqlite>] [--run <id>] [--video-from <stored prefix>] [--video-root <local prefix>]",
    });
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT b.id AS run_id,r.segment_id,r.response_text,v.start_seconds,v.end_seconds,v.source_video_path,v.selection_stratum,v.target_events_json,b.scoring_include_not_shown_annotations AS include_hidden,r.section_cost_usd AS cost_usd FROM raw_model_responses r JOIN model_evaluations m ON m.id=r.model_evaluation_id JOIN benchmark_runs b ON b.id=r.benchmark_run_id JOIN video_segments v ON v.id=r.segment_id AND v.segment_selection_id=b.segment_selection_id WHERE m.provider_model_id=${baselineModel} AND (${values.run ?? null} IS NULL OR b.id=${values.run ?? null}) ORDER BY b.id,r.segment_id,r.created_at,r.id`;
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(BenchmarkRow))(rows);
    if (new Set(decoded.map((r) => r.run_id)).size !== 1)
      return yield* new ComparisonError({
        operation: "select",
        resource: values.db,
        cause: "Choose one run with flash-lite responses using --run",
      });
    const from = values["video-from"];
    const relocated = decoded.map((r) =>
      r.source_video_path.startsWith(`${from}/`)
        ? { ...r, source_video_path: values["video-root"] + r.source_video_path.slice(from.length) }
        : r,
    );
    return [...new Map(relocated.map((r) => [r.segment_id, r])).values()];
  }).pipe(Effect.provide(SqliteClient.layer({ filename: values.db, readonly: true })));
  const selected = yield* Effect.try({
    try: () => selectStratified(rows, Number(values.n)),
    catch: (cause) => new ComparisonError({ operation: "select", resource: values.db, cause }),
  });
  const truth = yield* Effect.forEach(selected, (row) =>
    Schema.decodeEffect(Schema.fromJsonString(Truth))(row.target_events_json),
  );
  if (
    targetEventClasses.some(
      (c) => !truth.some((events) => events.some((e) => e.targetClass === c)),
    ) ||
    !truth.some((events) => events.every((e) => e.targetClass === null))
  )
    return yield* new ComparisonError({
      operation: "select",
      resource: values.db,
      cause: "Sample must contain all target classes and negative segments",
    });
  const strata = Object.fromEntries(
    [...new Set(selected.map((r) => r.selection_stratum))]
      .sort()
      .map((stratum) => [stratum, selected.filter((r) => r.selection_stratum === stratum).length]),
  );
  yield* Console.log(
    JSON.stringify(
      { run: selected[0]?.run_id, n: selected.length, seed: comparisonSeed, strata },
      null,
      2,
    ),
  );
  const path = yield* Path.Path;
  const override = yield* Config.option(Config.String("TCC_DATA_DIR"));
  const xdg = yield* Config.option(Config.String("XDG_DATA_HOME"));
  const home = yield* Config.String("HOME");
  const dataDir = Option.getOrElse(override, () =>
    path.join(
      Option.getOrElse(xdg, () => path.join(home, ".local", "share")),
      "tcc-highlights",
    ),
  );
  const budget = yield* Config.Number("OPENROUTER_BUDGET_USD").pipe(Config.withDefault(0));
  yield* Schema.decodeEffect(NonNegative)(budget);
  const fallbackRate = yield* Config.Number("OPENROUTER_RESERVATION_USD_PER_SECOND").pipe(
    Config.withDefault(0.001),
  );
  const outputRate = yield* Config.Number("OPENROUTER_OUTPUT_USD_PER_TOKEN").pipe(
    Config.withDefault(0.00001),
  );
  yield* Schema.decodeEffect(NonNegative)(fallbackRate);
  yield* Schema.decodeEffect(NonNegative)(outputRate);
  yield* acquireDataDirectoryLock(dataDir);
  const database = databaseLayer(path.join(dataDir, "highlights.sqlite"));
  const ledger = attemptLedgerLayer.pipe(Layer.provideMerge(database));
  const media = Layer.mergeAll(blobStoreLayer(dataDir), mediaProbeLayer).pipe(
    Layer.provideMerge(processLayer),
  );
  const apiKey = values["dry-run"] ? "" : yield* Config.String("OPENROUTER_API_KEY");
  const provider = openRouterLayer(apiKey).pipe(
    Layer.provide(persistedFreeModelLimiterLayer(50).pipe(Layer.provide(database))),
  );
  const llm = llmStepLayer(budget).pipe(
    Layer.provideMerge(ledger),
    Layer.provideMerge(media),
    Layer.provide(provider),
  );
  const services = comparisonLayer.pipe(
    Layer.provide(llm),
    Layer.provide(repositoryLayer.pipe(Layer.provide(database))),
  );
  const report = yield* Comparison.use((service) =>
    service.run(selected, {
      dryRun: values["dry-run"],
      retryAmbiguous: values["retry-ambiguous"],
      budget,
      fallbackRate,
      outputRate,
    }),
  ).pipe(Effect.provide(services));
  const output = {
    run: selected[0]?.run_id,
    models: { glm: comparisonModel, baseline: baselineModel },
    promptVersion: "benchmark-v1",
    seed: comparisonSeed,
    strata,
    report,
  };
  yield* (yield* FileSystem.FileSystem).writeFileString(
    values.out,
    JSON.stringify(output, null, 2) + "\n",
  );
  yield* Console.log(JSON.stringify(output, null, 2));
});
NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
