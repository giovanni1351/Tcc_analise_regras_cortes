import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { JobError, type StageRunKey } from "@tcc/contracts";
import { Repository, emptyCoverage } from "./repository.ts";
import { Runner } from "./runner.ts";
import { Sources } from "./sources.ts";
import { type StageLogic, type StageOutput } from "./stages.ts";
import { fixtureServices } from "./fixtures.testkit.ts";

const output = {
  artifact: [],
  device: "cpu",
  writeRows: () => Effect.void,
  coverage: emptyCoverage,
} satisfies StageOutput;
const logic = (run: StageLogic["Service"]["run"]): StageLogic["Service"] => ({
  version: () => "test-v1",
  params: () => ({}),
  run,
});
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const path = `${directory}/video.bin`;
  yield* fs.writeFileString(path, "original");
  return { fs, directory, path };
});
const create = Effect.fn("Test.create")(function* (path: string) {
  const sources = yield* Sources;
  const repo = yield* Repository;
  const source = yield* sources.register({ _tag: "LocalFile", path });
  return yield* repo.create(source.id);
});

it.effect("source and job registration are idempotent, force creates a job, list is paged", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    yield* Effect.gen(function* () {
      const repo = yield* Repository;
      const sources = yield* Sources;
      const first = yield* create(path);
      const same = yield* create(path);
      assert.strictEqual(first.id, same.id);
      const source = yield* sources.register({ _tag: "LocalFile", path });
      const forced = yield* repo.create(source.id, undefined, true);
      assert.notStrictEqual(forced.id, first.id);
      const page = yield* repo.list(1, 1);
      assert.strictEqual(page.total, 2);
      assert.strictEqual(page.jobs.length, 1);
      assert.strictEqual((yield* repo.list(-1).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(fixtureServices(directory)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "V5 interrupt after artifact publication rolls back rows; restart requeues and reuses finished stages",
  () =>
    Effect.gen(function* () {
      const { directory, path } = yield* setup;
      const wrote = yield* Deferred.make<void>();
      const database = `${directory}/jobs.sqlite`;
      const crashing = logic((stage) =>
        Effect.succeed(
          stage === "scenes"
            ? {
                ...output,
                writeRows: (key: StageRunKey) =>
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`INSERT INTO scenes VALUES (${key},0,0,1,0,1)`;
                    yield* Deferred.succeed(wrote, undefined);
                    return yield* Effect.never;
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new JobError({ stage, category: "Persistence", message: String(cause) }),
                    ),
                  ),
              }
            : output,
        ),
      );
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* Runner;
          const job = yield* create(path);
          yield* runner.start;
          yield* Deferred.await(wrote);
          return job.id;
        }).pipe(Effect.provide(fixtureServices(directory, database, crashing))),
      );
      const completed = yield* Deferred.make<void>();
      const executed: Array<string> = [];
      const restarting = logic((stage) =>
        Effect.sync(() => {
          executed.push(stage);
          return stage === "highlights"
            ? {
                ...output,
                writeRows: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
              }
            : output;
        }),
      );
      yield* Effect.gen(function* () {
        const repo = yield* Repository;
        const sql = yield* SqlClient.SqlClient;
        const runner = yield* Runner;
        const rows = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM scenes`;
        assert.strictEqual(rows[0]?.total, 0);
        const published = yield* sql<{
          stage: string;
        }>`SELECT stage FROM stage_runs WHERE status='Finished'`;
        assert.deepStrictEqual(
          published.map((r) => r.stage),
          ["probe"],
        );
        assert.strictEqual((yield* repo.job(id)).state._tag, "Running");
        yield* runner.start;
        yield* Deferred.await(completed);
        assert.notInclude(executed, "probe");
        assert.include(executed, "scenes");
      }).pipe(Effect.provide(fixtureServices(directory, database, restarting)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("V5 cancel mid-stage releases scoped resources and keeps runner alive", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const next = yield* Deferred.make<void>();
    let invocations = 0;
    const blocking = logic(() =>
      Effect.gen(function* () {
        if (invocations++ > 0) {
          yield* Deferred.succeed(next, undefined);
          return output;
        }
        yield* Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
          Deferred.succeed(released, undefined),
        );
        return yield* Effect.never;
      }).pipe(Effect.scoped),
    );
    yield* Effect.gen(function* () {
      const runner = yield* Runner;
      const repo = yield* Repository;
      const job = yield* create(path);
      yield* runner.start;
      yield* Deferred.await(entered);
      assert.strictEqual((yield* runner.cancel(job.id)).state._tag, "Cancelled");
      yield* Deferred.await(released);
      assert.strictEqual((yield* repo.job(job.id)).state._tag, "Cancelled");
      const rows =
        yield* (yield* SqlClient.SqlClient)`SELECT key FROM stage_runs WHERE status='Finished'`;
      assert.strictEqual(rows.length, 0);
      yield* repo.create(job.sourceId, undefined, true);
      yield* runner.notify;
      yield* Deferred.await(next);
    }).pipe(Effect.provide(fixtureServices(directory, ":memory:", blocking)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("V5 changing source between stages raises SourceChanged", () =>
  Effect.gen(function* () {
    const { directory, path, fs } = yield* setup;
    yield* Effect.gen(function* () {
      const repo = yield* Repository;
      const sources = yield* Sources;
      const job = yield* create(path);
      yield* sources.check(job.sourceId, "probe");
      yield* fs.writeFileString(path, "changed content size");
      const changed = yield* sources.check(job.sourceId, "scenes").pipe(Effect.result);
      assert.strictEqual(changed._tag, "Failure");
      if (changed._tag === "Failure") {
        assert.strictEqual(changed.failure._tag, "JobError");
        if (changed.failure._tag === "JobError")
          assert.strictEqual(changed.failure.category, "SourceChanged");
      }
      assert.strictEqual((yield* repo.job(job.id)).sourceId, job.sourceId);
    }).pipe(Effect.provide(fixtureServices(directory)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
