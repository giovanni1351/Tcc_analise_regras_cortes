import * as NodeProcess from "node:process";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { HttpApiClient } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Api } from "@tcc/contracts";
import { migrate } from "./migrations.ts";
import { databaseLayer } from "./database.ts";
import { BudgetService, budgetLayer } from "./budget.ts";
import { httpLayer } from "./http.ts";
import { Process, processLayer } from "./process.ts";
import { acquireDataDirectoryLock } from "./lock.ts";
import { testServices } from "./jobs/fixtures.testkit.ts";

it.effect("migrates an in-memory database once", () =>
  Effect.gen(function* () {
    const first = yield* migrate;
    const second = yield* migrate;
    assert.strictEqual(first.length, 3);
    assert.deepStrictEqual(second, []);
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
    assert.includeMembers(
      tables.map((row) => row.name),
      [
        "media",
        "sources",
        "jobs",
        "stage_runs",
        "job_stages",
        "scenes",
        "samples",
        "windows",
        "segments",
        "llm_attempts",
        "highlights",
      ],
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("file migrations survive reopening and are a no-op", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const filename = `${dir}/test.sqlite`;
    const first = yield* Effect.scoped(
      migrate.pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
    const second = yield* Effect.scoped(
      migrate.pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
    assert.strictEqual(first.length, 3);
    assert.deepStrictEqual(second, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("interrupting a fiber kills its scoped child process", () =>
  Effect.gen(function* () {
    const service = yield* Process;
    const started = yield* Deferred.make<number>();
    const fiber = yield* Effect.gen(function* () {
      const child = yield* service.spawn("sleep", ["30"]);
      yield* Deferred.succeed(started, child.pid);
      return yield* Effect.never;
    }).pipe(Effect.scoped, Effect.forkChild);
    const pid = yield* Deferred.await(started);
    assert.doesNotThrow(() => NodeProcess.kill(pid, 0));
    yield* Fiber.interrupt(fiber);
    assert.throws(() => NodeProcess.kill(pid, 0), /ESRCH/);
  }).pipe(Effect.scoped, Effect.provide(processLayer), Effect.provide(NodeServices.layer)),
);

it.live("generated client reads zero budget from a live server", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api);
    const result = yield* client.highlights.budget();
    assert.deepStrictEqual(result, {
      limitUsd: 0,
      committedUsd: 0,
      reservedUsd: 0,
      ambiguousUsd: 0,
    });
    const missing = yield* client.highlights.listJobs({ query: {} }).pipe(Effect.result);
    assert.strictEqual(missing._tag, "Success");
  }).pipe(
    Effect.provide(httpLayer.pipe(Layer.provide(testServices))),
    Effect.provide(NodeHttpServer.layerTest),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("second acquisition fails with DataDirectoryLocked", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* acquireDataDirectoryLock(dir);
    const second = yield* acquireDataDirectoryLock(dir).pipe(Effect.result);
    assert.strictEqual(second._tag, "Failure");
    if (second._tag === "Failure") assert.strictEqual(second.failure._tag, "DataDirectoryLocked");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("budget counts actual costs and keeps ambiguous reservations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO media VALUES ('hash',1,'{}')`;
    yield* sql`INSERT INTO sources VALUES ('source','{}','hash',1,0)`;
    yield* sql`INSERT INTO jobs VALUES ('job','source','spec','{}','{}','Queued',0,'now','now')`;
    yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES ('run','segments','v1','{}','Finished')`;
    yield* sql`INSERT INTO windows VALUES ('window','run',0,10,'[]')`;
    yield* sql`INSERT INTO segments VALUES ('segment','run','window','blob',0,10)`;
    yield* sql`INSERT INTO llm_attempts (id,job_id,segment_id,model,prompt_version,attempt_number,state,reserved_usd,cost_usd,created_at,updated_at) VALUES
 ('a','job','segment','model','v1',1,'Answered',1,0.2,'now','now'),
 ('b','job','segment','model','v1',2,'Reserved',0.3,NULL,'now','now'),
 ('c','job','segment','model','v1',3,'Ambiguous',0.4,NULL,'now','now'),
 ('d','job','segment','model','v1',4,'Failed',1,0,'now','now')`;
    const service = yield* BudgetService;
    assert.deepStrictEqual(yield* service.get, {
      limitUsd: 1,
      committedUsd: 0.2,
      reservedUsd: 0.7,
      ambiguousUsd: 0.4,
    });
  }).pipe(Effect.provide(budgetLayer(1).pipe(Layer.provideMerge(databaseLayer(":memory:"))))),
);

it.live("closing the lock scope allows reuse of the same lock file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* Effect.scoped(acquireDataDirectoryLock(dir));
    yield* acquireDataDirectoryLock(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
