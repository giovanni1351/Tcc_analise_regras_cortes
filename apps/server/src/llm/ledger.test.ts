import { assert, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { AttemptLedger, attemptLedgerLayer } from "./ledger.ts";
import { FreeModelLimiter, persistedFreeModelLimiterLayer } from "./limiter.ts";
import { databaseLayer } from "../database.ts";
import { BudgetService, budgetLayer } from "../budget.ts";
import { ProviderError } from "../services.ts";
import { parseVerdict } from "./verdict.ts";
import successful from "../../test/fixtures/openrouter/real-free.json" with { type: "json" };

const db = databaseLayer(":memory:");
const services = Layer.mergeAll(attemptLedgerLayer, budgetLayer(1)).pipe(Layer.provideMerge(db));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO media VALUES ('hash',1,'{}')`;
  yield* sql`INSERT INTO sources VALUES ('source','{}','hash',1,0)`;
  yield* sql`INSERT INTO jobs VALUES ('job','source','spec','{}','{}','Queued',0,'now','now')`;
  yield* sql`INSERT INTO jobs VALUES ('other','source','other-spec','{}','{}','Queued',0,'now','now')`;
  yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES ('run','llm','v1','{}','Running')`;
  yield* sql`INSERT INTO windows VALUES ('window','run',0,10,'[]')`;
  yield* sql`INSERT INTO segments VALUES ('segment','run','window','hash',0,10)`;
});
const reservation = {
  id: "one",
  jobId: "job",
  segmentId: "segment",
  model: "model",
  promptVersion: "benchmark-v1",
  attemptNumber: 1,
  reservation: 0.4,
  jobCapUsd: 0.5,
  accountCapUsd: 0.7,
};
it.effect(
  "reserves transactionally, recovers Sent with its reservation and records full answers",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const ledger = yield* AttemptLedger;
      const budget = yield* BudgetService;
      const sql = yield* SqlClient.SqlClient;
      assert.isTrue(yield* ledger.reserve(reservation));
      assert.isFalse(yield* ledger.reserve({ ...reservation, id: "denied", attemptNumber: 2 }));
      assert.isFalse(
        yield* ledger.reserve({
          ...reservation,
          id: "account-denied",
          jobId: "other",
          attemptNumber: 2,
        }),
      );
      yield* ledger.markSent("one");
      yield* ledger.recoverOnStartup;
      yield* ledger.recoverOnStartup;
      assert.deepStrictEqual(yield* budget.get, {
        limitUsd: 1,
        committedUsd: 0,
        reservedUsd: 0.4,
        ambiguousUsd: 0.4,
      });
      const parsed = parseVerdict(successful, 10);
      assert.strictEqual(parsed._tag, "Valid");
      yield* ledger.answer("one", successful, parsed);
      const rows = yield* sql`SELECT * FROM llm_attempts WHERE id='one'`;
      assert.strictEqual(rows[0]?.state, "Answered");
      assert.strictEqual(rows[0]?.response_json, JSON.stringify(successful.body));
      assert.strictEqual(rows[0]?.generation_id, successful.generationId);
      assert.deepStrictEqual(yield* budget.get, {
        limitUsd: 1,
        committedUsd: 0,
        reservedUsd: 0,
        ambiguousUsd: 0,
      });
      assert.isTrue(yield* ledger.reserve({ ...reservation, id: "two", attemptNumber: 2 }));
      yield* ledger.markSent("two");
      yield* ledger.answer(
        "two",
        { ...successful, costUsd: 0.2 },
        { _tag: "Invalid", reason: "schema violation" },
      );
      const invalid = yield* sql`SELECT parse_error_json,cost_usd FROM llm_attempts WHERE id='two'`;
      assert.strictEqual(invalid[0]?.parse_error_json, JSON.stringify("schema violation"));
      assert.strictEqual((yield* budget.get).committedUsd, 0.2);
      assert.isFalse(yield* ledger.reserve({ ...reservation, id: "three", attemptNumber: 3 }));
    }).pipe(Effect.provide(services)),
);
it.effect("serializes concurrent admission and rolls back duplicate inserts", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    const results = yield* Effect.all(
      [
        ledger.reserve(reservation),
        ledger.reserve({ ...reservation, id: "two", attemptNumber: 2 }),
      ],
      { concurrency: "unbounded" },
    );
    assert.strictEqual(results.filter(Boolean).length, 1);
    const budget = yield* BudgetService;
    assert.strictEqual((yield* budget.get).reservedUsd, 0.4);
    const duplicate = yield* ledger.reserve({ ...reservation, reservation: 0 }).pipe(Effect.result);
    assert.strictEqual(duplicate._tag, "Failure");
    assert.strictEqual((yield* budget.get).reservedUsd, 0.4);
  }).pipe(Effect.provide(services)),
);
it.effect("fails unsent attempts and rejects invalid transitions", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    yield* ledger.reserve(reservation);
    yield* ledger.fail("one", "cancelled before send");
    const invalid = yield* ledger.markSent("one").pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
    const budget = yield* BudgetService;
    assert.strictEqual((yield* budget.get).reservedUsd, 0);
  }).pipe(Effect.provide(services)),
);

it.effect("keeps the reservation of an answer with unknown cost without marking it ambiguous", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    const budget = yield* BudgetService;
    yield* ledger.reserve(reservation);
    yield* ledger.markSent("one");
    yield* ledger.answer("one", { ...successful, costUsd: null }, parseVerdict(successful, 10));
    const after = yield* budget.get;
    assert.strictEqual(after.reservedUsd, 0.4);
    assert.strictEqual(after.ambiguousUsd, 0);
  }).pipe(Effect.provide(services)),
);

it.effect("retains a network failure after sending as ambiguous", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    const budget = yield* BudgetService;
    yield* ledger.reserve({ ...reservation, id: "two", attemptNumber: 2 });
    yield* ledger.markSent("two");
    yield* ledger.fail(
      "two",
      new ProviderError({
        category: "Network",
        httpStatus: null,
        retryAfterMs: null,
        message: "Lost response",
      }),
    );
    assert.strictEqual((yield* budget.get).ambiguousUsd, 0.4);
  }).pipe(Effect.provide(services)),
);

it.effect("local limiter rejection releases the reservation and stores no send", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    yield* ledger.reserve(reservation);
    yield* ledger.markSent("one");
    yield* ledger.fail(
      "one",
      new ProviderError({
        category: "RateLimited",
        httpStatus: null,
        retryAfterMs: 1000,
        message: "Local quota",
        sent: false,
      }),
    );
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT state FROM llm_attempts WHERE id='one'`;
    assert.strictEqual(rows[0]?.state, "Failed");
    assert.strictEqual((yield* (yield* BudgetService).get).reservedUsd, 0);
  }).pipe(Effect.provide(services)),
);

it.effect("restart restores both quotas and ignores locally rejected attempts", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* AttemptLedger;
    for (let i = 0; i < 50; i++) {
      const id = String(i);
      yield* ledger.reserve({
        ...reservation,
        id,
        model: "model:free",
        attemptNumber: i + 1,
        reservation: 0,
      });
      const state = i < 5 ? "Sent" : i < 10 ? "Answered" : i < 15 ? "Ambiguous" : "Failed";
      const status = i >= 15 && i < 20 ? 429 : null;
      yield* sql`UPDATE llm_attempts SET state=${state},http_status=${status},created_at='1970-01-01T00:00:00.000Z' WHERE id=${id}`;
    }
    yield* Effect.gen(function* () {
      const limiter = yield* FreeModelLimiter;
      assert.strictEqual((yield* limiter.acquire.pipe(Effect.flip)).period, "minute");
      yield* TestClock.adjust(60_000);
      yield* limiter.acquire;
      assert.strictEqual((yield* limiter.acquire.pipe(Effect.flip)).period, "day");
    }).pipe(Effect.provide(persistedFreeModelLimiterLayer(21)));
  }).pipe(Effect.provide(services)),
);

it.effect("free reservations bypass exhausted job and account admission", () =>
  Effect.gen(function* () {
    yield* seed;
    const ledger = yield* AttemptLedger;
    yield* ledger.reserve(reservation);
    assert.isTrue(
      yield* ledger.reserve({
        ...reservation,
        id: "free",
        model: "model:free",
        attemptNumber: 2,
        reservation: 0,
        jobCapUsd: 0,
        accountCapUsd: 0,
      }),
    );
  }).pipe(Effect.provide(services)),
);
