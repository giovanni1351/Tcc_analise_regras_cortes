import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { gunzipSync } from "node:zlib";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { defaultRuleConfig } from "@tcc/contracts";
import { evaluateVideo, StudyVideo, summarizeRules, testGames, studyLabels } from "./rules.ts";

class RulesEvalError extends Schema.TaggedError<
  RulesEvalError,
  { readonly brand: unique symbol }
>()("RulesEvalError", {
  operation: Schema.String,
  resource: Schema.String,
  cause: Schema.Defect(),
}) {}

const Manifest = Schema.Struct({ files: Schema.Array(Schema.String) });
const Saved = Schema.Struct({
  configurations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      labels: Schema.Array(Schema.String),
      event_delta: Schema.Number,
      config: Schema.Struct({
        short: Schema.Number,
        zero: Schema.Number,
        cluster: Schema.Number,
        preceding: Schema.Boolean,
        before: Schema.Number,
        after: Schema.Number,
        rule: Schema.String,
      }),
      dataset: Schema.Struct({
        videos: Schema.Number,
        games: Schema.Number,
        duration_sec: Schema.Number,
      }),
      summary: Schema.Array(
        Schema.Struct({
          split: Schema.String,
          hits: Schema.Number,
          events: Schema.Number,
          recall: Schema.Number,
          coverage: Schema.Number,
          proposal_precision: Schema.Number,
          proposals: Schema.Number,
          reducao_temporal: Schema.Number,
        }),
      ),
    }),
  ),
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [directory, ...args] = process.argv.slice(2);
  if (
    !directory ||
    (args.length > 0 && (args.length !== 2 || args[0] !== "--config" || args[1] !== "C"))
  ) {
    return yield* new RulesEvalError({
      operation: "arguments",
      resource: "argv",
      cause: "Usage: node apps/server/src/eval/rules-cli.ts <exportDir> [--config C]",
    });
  }
  const entries = yield* fs.readDirectory(directory);
  const files = entries.includes("manifest.json")
    ? (yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
        yield* fs.readFileString(path.join(directory, "manifest.json")),
      )).files
    : entries.filter((f) => f.endsWith(".json.gz")).sort();
  const rows: ReturnType<typeof evaluateVideo>[] = [];
  for (const file of files) {
    const compressed = yield* fs.readFile(path.join(directory, file));
    const json = yield* Effect.try({
      try: () => gunzipSync(compressed).toString("utf8"),
      catch: (cause) => new RulesEvalError({ operation: "decompress", resource: file, cause }),
    });
    const video = yield* Schema.decodeEffect(Schema.fromJsonString(StudyVideo))(json);
    rows.push(evaluateVideo(video, defaultRuleConfig));
  }
  const games = testGames(rows.map((r) => r.game));
  const measured = [
    summarizeRules(
      rows.filter((r) => !games.has(r.game)),
      "train",
    ),
    summarizeRules(
      rows.filter((r) => games.has(r.game)),
      "test",
    ),
    summarizeRules(rows, "all"),
  ];
  for (const result of measured) yield* Console.log(JSON.stringify(result));
  const saved = (yield* Schema.decodeEffect(Schema.fromJsonString(Saved))(
    yield* fs.readFileString(
      new URL("../../../../saved_rules/configurations.json", import.meta.url).pathname,
    ),
  )).configurations.find((c) => c.name === "redução de 31 e 91 de recall");
  if (!saved)
    return yield* new RulesEvalError({
      operation: "compare",
      resource: "saved_rules/configurations.json",
      cause: "Saved config C not found",
    });
  const differences: string[] = [];
  if (saved.event_delta !== 0) differences.push("event_delta");
  if (saved.config.rule !== "zero") differences.push("config.rule");
  if (saved.labels.toSorted().join("|") !== studyLabels.toSorted().join("|"))
    differences.push("labels");
  for (const key of ["short", "zero", "cluster", "preceding", "before", "after"] as const) {
    if (defaultRuleConfig[key] !== saved.config[key]) differences.push(`config.${key}`);
  }
  const all = measured[2]!;
  if (all.videos !== saved.dataset.videos) differences.push("dataset.videos");
  if (all.games !== saved.dataset.games) differences.push("dataset.games");
  if (Math.abs(all.durationSec - saved.dataset.duration_sec) > 0.001)
    differences.push("dataset.duration_sec");
  saved.summary.forEach((expected) => {
    const split =
      expected.split === "treino" ? "train" : expected.split === "teste" ? "test" : "all";
    const actual = measured.find((row) => row.split === split)!;
    const fields = [
      ["hits", actual.hits, expected.hits],
      ["events", actual.events, expected.events],
      ["recall", actual.recall, expected.recall],
      ["coverage", actual.coverage, expected.coverage],
      ["proposal_precision", actual.proposalPrecision, expected.proposal_precision],
      ["proposals", actual.proposals, expected.proposals],
      ["reducao_temporal", actual.reduction, expected.reducao_temporal],
    ] as const;
    for (const [key, value, expectedValue] of fields) {
      if (!Number.isFinite(value) || Math.abs(value - expectedValue) > 0.0000005)
        differences.push(`${actual.split}.${key}`);
    }
  });
  yield* Console.log(
    JSON.stringify({ savedConfig: saved.name, matches: differences.length === 0, differences }),
  );
});
NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
