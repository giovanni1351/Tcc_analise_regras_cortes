import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { JobError, type StageRunKey } from "@tcc/contracts";
import { Repository, emptyCoverage } from "./repository.ts";
import { Runner } from "./runner.ts";
import { Sources } from "./sources.ts";
import { StageRuns, stages, type StageInput, type StageLogic, type StageOutput } from "./stages.ts";
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

it.effect("forced jobs reuse all stage keys and never invoke the LLM twice", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    let calls = 0;
    yield* Effect.gen(function* () {
      const repo = yield* Repository;
      const sources = yield* Sources;
      const runs = yield* StageRuns;
      const first = yield* create(path);
      const second = yield* repo.create(first.sourceId, undefined, true);
      const keys = [];
      for (const job of [first, second]) {
        const inputs: Array<StageInput["inputs"][number]> = [];
        const media = yield* sources.check(job.sourceId, "probe");
        for (const stage of stages)
          inputs.push(
            yield* runs.execute(stage, {
              job,
              media,
              inputs,
              retryAmbiguous: false,
              progress: () => Effect.void,
            }),
          );
        keys.push(inputs.map((item) => item.key));
      }
      assert.deepStrictEqual(keys[0], keys[1]);
      assert.strictEqual(calls, 1);
    }).pipe(
      Effect.provide(
        fixtureServices(
          directory,
          ":memory:",
          logic(() => Effect.succeed(output)),
          {
            run: () =>
              Effect.sync(() => {
                calls++;
                return output;
              }),
          },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("partial verdicts publish highlights and leave them rebuildable on resume", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    let highlights = 0;
    let verdicts = 0;
    const partial = { _tag: "AmbiguousAttempts", count: 1 } as const;
    const stageLogic = logic((stage) =>
      Effect.sync(() => {
        if (stage === "highlights") highlights++;
        return output;
      }),
    );
    yield* Effect.gen(function* () {
      const job = yield* create(path);
      const media = yield* (yield* Sources).check(job.sourceId, "probe");
      const runs = yield* StageRuns;
      for (let run = 0; run < 2; run++) {
        const inputs: Array<StageInput["inputs"][number]> = [];
        let incomplete: typeof partial | undefined;
        for (const stage of stages) {
          const result = yield* runs.execute(stage, {
            job,
            media,
            inputs,
            retryAmbiguous: run > 0,
            ...(incomplete ? { partial: incomplete } : {}),
            progress: () => Effect.void,
          });
          inputs.push(result);
          if (result.partial) incomplete = partial;
        }
      }
      assert.strictEqual(verdicts, 2);
      assert.strictEqual(highlights, 2);
      const rows = yield* (yield* SqlClient.SqlClient)<{
        status: string;
      }>`SELECT status FROM stage_runs WHERE stage='highlights'`;
      assert.strictEqual(rows[0]?.status, "Finished");
    }).pipe(
      Effect.provide(
        fixtureServices(directory, ":memory:", stageLogic, {
          run: () => Effect.sync(() => ({ ...output, ...(verdicts++ === 0 ? { partial } : {}) })),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "source refs retain distinct locations and identities while sharing media and caches",
  () =>
    Effect.gen(function* () {
      const { directory, path, fs } = yield* setup;
      const otherPath = `${directory}/other.bin`;
      yield* fs.copyFile(path, otherPath);
      yield* Effect.gen(function* () {
        const sources = yield* Sources;
        const repo = yield* Repository;
        const first = yield* sources.register({ _tag: "LocalFile", path });
        const other = yield* sources.register({ _tag: "LocalFile", path: otherPath });
        assert.notStrictEqual(first.id, other.id);
        assert.strictEqual(first.mediaHash, other.mediaHash);
        assert.deepStrictEqual(other.ref, { _tag: "LocalFile", path: otherPath });
        const soccer = {
          _tag: "SoccerNetHalf",
          league: "league",
          season: "season",
          game: "game",
          half: 2,
          resolution: "224p",
        } as const;
        const half = yield* repo.register(soccer, first.mediaHash, first.probe, 8, 0);
        assert.notStrictEqual(half.id, first.id);
        assert.deepStrictEqual(half.ref, soccer);
        assert.strictEqual(
          (yield* repo.register(
            {
              resolution: "224p",
              half: 2,
              game: "game",
              season: "season",
              league: "league",
              _tag: "SoccerNetHalf",
            },
            first.mediaHash,
            first.probe,
            8,
            0,
          )).id,
          half.id,
        );
        yield* fs.remove(path);
        assert.strictEqual((yield* sources.check(other.id, "scenes")).path, otherPath);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT COUNT(*) AS n FROM media`)[0]?.n, 1);
      }).pipe(Effect.provide(fixtureServices(directory)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runner records defects as Failed and continues with queued jobs", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    const next = yield* Deferred.make<void>();
    let failingId = "";
    yield* Effect.gen(function* () {
      const repo = yield* Repository;
      const first = yield* create(path);
      failingId = first.id;
      yield* (yield* SqlClient.SqlClient)`UPDATE jobs SET created_at='2000' WHERE id=${first.id}`;
      yield* repo.change(first.id, { _tag: "Start" });
      yield* repo.change(first.id, { _tag: "Recover" });
      yield* repo.create(first.sourceId, undefined, true);
      yield* (yield* Runner).start;
      yield* Deferred.await(next);
      const state = (yield* repo.job(first.id)).state;
      assert.strictEqual(state._tag, "Failed");
      if (state._tag === "Failed") assert.include(state.error.message, "broken stage");
    }).pipe(
      Effect.provide(
        fixtureServices(
          directory,
          ":memory:",
          logic((_, input) =>
            input.job.id === failingId
              ? Effect.die("broken stage")
              : Deferred.succeed(next, undefined).pipe(Effect.as(output)),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("highlight cache rebuilds stale rows from its artifact without another job", () =>
  Effect.gen(function* () {
    const { directory, path } = yield* setup;
    yield* Effect.gen(function* () {
      const job = yield* create(path);
      const sql = yield* SqlClient.SqlClient;
      const media = yield* (yield* Sources).check(job.sourceId, "highlights");
      const runs = yield* StageRuns;
      yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES ('seed','segments','v1','{}','Finished')`;
      yield* sql`INSERT INTO windows VALUES ('window','seed',0,10,'[]')`;
      yield* sql`INSERT INTO segments VALUES ('segment','seed','window',${media.hash},0,10)`;
      yield* sql`INSERT INTO llm_attempts (id,job_id,segment_id,model,prompt_version,attempt_number,state,reserved_usd,created_at,updated_at) VALUES ('attempt',${job.id},'segment','paid','v1',1,'Answered',0,'now','now')`;
      const input = { job, media, inputs: [], retryAmbiguous: false, progress: () => Effect.void };
      yield* runs.execute("highlights", input);
      yield* sql`INSERT INTO highlights VALUES ('stale',${job.id},'Goal',NULL,9,1,'segment','attempt',NULL)`;
      yield* runs.execute("highlights", input);
      const result = yield* (yield* Repository).result(job.id);
      assert.strictEqual(result.highlights.length, 1);
      assert.strictEqual(result.highlights[0]?.videoSeconds, 2);
      yield* sql`DELETE FROM highlights WHERE job_id=${job.id}`;
      yield* runs.execute("highlights", input);
      assert.strictEqual((yield* (yield* Repository).result(job.id)).highlights.length, 1);
    }).pipe(
      Effect.provide(
        fixtureServices(
          directory,
          ":memory:",
          logic(() =>
            Effect.succeed({
              ...output,
              artifact: [
                {
                  id: "published",
                  class: "Goal",
                  half: null,
                  videoSeconds: 2,
                  confidence: 1,
                  segmentId: "segment",
                  attemptId: "attempt",
                  clipUrl: null,
                },
              ],
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
