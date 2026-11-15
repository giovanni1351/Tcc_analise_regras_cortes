import { Effect, Console, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { parseStructuredPrediction } from "./rescore-parser.ts";
import { matchAt5 } from "./rescore.ts";

const Row = Schema.Struct({
  model: Schema.String,
  segment_id: Schema.String,
  response_text: Schema.String,
  start_seconds: Schema.Number,
  target_events_json: Schema.String,
  include_hidden: Schema.Number,
});
const Truth = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    targetClass: Schema.NullOr(Schema.String),
    seconds: Schema.Number,
    visibility: Schema.String,
  }),
);
const filename = process.argv[2];
if (!filename)
  throw new Error("Usage: node apps/server/src/eval/rescore-cli.ts <sqlite> [--model <id>]");
const modelFilter = process.argv[process.argv.indexOf("--model") + 1];
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT m.provider_model_id AS model,r.segment_id,r.response_text,v.start_seconds,v.target_events_json,b.scoring_include_not_shown_annotations AS include_hidden FROM raw_model_responses r JOIN model_evaluations m ON m.id=r.model_evaluation_id JOIN benchmark_runs b ON b.id=r.benchmark_run_id JOIN video_segments v ON v.id=r.segment_id AND v.segment_selection_id=b.segment_selection_id ORDER BY m.provider_model_id,r.segment_id`;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
  const totals = new Map<
    string,
    { rows: number; valid: number; tp: number; fp: number; fn: number }
  >();
  for (const row of decoded) {
    if (process.argv.includes("--model") && row.model !== modelFilter) continue;
    const truth = yield* Schema.decodeEffect(Schema.fromJsonString(Truth))(row.target_events_json);
    const parsed = parseStructuredPrediction({
      segmentId: row.segment_id,
      responseText: row.response_text,
    });
    const score = matchAt5(
      parsed.ok ? parsed.value.predictions : [],
      truth,
      row.start_seconds,
      row.include_hidden !== 0,
    );
    const total = totals.get(row.model) ?? { rows: 0, valid: 0, tp: 0, fp: 0, fn: 0 };
    total.rows++;
    total.valid += Number(parsed.ok);
    total.tp += score.tp;
    total.fp += score.fp;
    total.fn += score.fn;
    totals.set(row.model, total);
  }
  yield* Console.log("model rows TP FP FN F1@5s precision recall valid-rate");
  for (const [model, total] of totals) {
    const precision = total.tp / (total.tp + total.fp) || 0;
    const recall = total.tp / (total.tp + total.fn) || 0;
    const f1 = (2 * total.tp) / (2 * total.tp + total.fp + total.fn) || 0;
    yield* Console.log(
      `${model} ${total.rows} ${total.tp} ${total.fp} ${total.fn} ${f1.toFixed(9)} ${precision.toFixed(9)} ${recall.toFixed(9)} ${((100 * total.valid) / total.rows).toFixed(1)}%`,
    );
  }
});
await Effect.runPromise(
  program.pipe(Effect.provide(SqliteClient.layer({ filename, readonly: true }))),
);
