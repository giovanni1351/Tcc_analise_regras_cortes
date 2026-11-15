import { Context, Effect, Fiber, Layer, Queue, Schema } from "effect";
import {
  Conflict,
  NotFound,
  PersistenceError,
  JobError,
  JobId,
  type PartialReason,
  type Job,
} from "@tcc/contracts";
import { SqlClient } from "effect/sql";
import { Repository, emptyCoverage, persistence } from "./repository.ts";
import { Sources } from "./sources.ts";
import { StageRuns, stages, type StageInput } from "./stages.ts";

export const makeRunner = Effect.gen(function* () {
  const repo = yield* Repository;
  const sources = yield* Sources;
  const runs = yield* StageRuns;
  const sql = yield* SqlClient.SqlClient;
  const wake = yield* Queue.sliding<void>(1);
  let active: { readonly id: JobId; readonly fiber: Fiber.Fiber<void, never> } | undefined;
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const run = Effect.fn("Runner.run")(function* (job: Job) {
    const inputs: Array<StageInput["inputs"][number]> = [];
    let coverage = emptyCoverage;
    let partial: PartialReason | undefined;
    for (const stage of stages) {
      yield* repo.change(job.id, { _tag: "Progress", stage, done: 0, total: 1 });
      const media = yield* sources.check(job.sourceId, stage);
      const flags = yield* sql<{
        retry_ambiguous: number;
      }>`SELECT retry_ambiguous FROM job_options WHERE job_id=${job.id}`.pipe(
        persistence("resumeOptions"),
      );
      const output = yield* runs.execute(stage, {
        job,
        media,
        inputs,
        retryAmbiguous: flags[0]?.retry_ambiguous === 1,
        ...(partial ? { partial } : {}),
        progress: (done, total) =>
          repo
            .change(job.id, { _tag: "Progress", stage, done, total })
            .pipe(Effect.asVoid, Effect.orDie),
      });
      if (stage === "verdicts") {
        yield* sql`DELETE FROM retry_permissions WHERE job_id=${job.id}`.pipe(
          persistence("clearRetryPermissions"),
        );
        yield* sql`UPDATE job_options SET retry_ambiguous=0 WHERE job_id=${job.id}`.pipe(
          persistence("clearResumeOptions"),
        );
      }
      inputs.push(output);
      if (output.coverage) coverage = output.coverage;
      partial = output.partial ?? partial;
    }
    yield* repo.change(job.id, {
      _tag: "Complete",
      state: partial
        ? { _tag: "Partial", coverage, reason: partial }
        : { _tag: "Succeeded", coverage },
    });
  });
  const handled = Effect.fn("Runner.handled")((job: Job) =>
    run(job).pipe(
      Effect.scoped,
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const current = yield* repo.job(job.id);
          if (current.state._tag !== "Running") return;
          const stage = current.state.stage;
          const error = Schema.is(JobError)(cause)
            ? cause
            : new JobError({ stage, category: "Persistence", message: String(cause) });
          yield* sql`UPDATE stage_runs SET status='Failed',error_json=${JSON.stringify(error)} WHERE key=(SELECT stage_run_key FROM job_stages WHERE job_id=${job.id} AND stage=${stage}) AND status='Running'`.pipe(
            persistence("failStage"),
          );
          yield* repo.change(job.id, { _tag: "Complete", state: { _tag: "Failed", stage, error } });
        }).pipe(Effect.catchCause(Effect.logError)),
      ),
    ),
  );
  const start = Effect.gen(function* () {
    yield* repo.recover();
    yield* notify;
    yield* Effect.gen(function* () {
      yield* Queue.take(wake);
      let job = yield* repo.claim();
      while (job) {
        const fiber = yield* handled(job).pipe(Effect.forkChild);
        active = { id: job.id, fiber };
        yield* Fiber.await(fiber);
        active = undefined;
        job = yield* repo.claim();
      }
    }).pipe(Effect.forever, Effect.forkScoped);
  });
  const cancel = Effect.fn("Runner.cancel")(function* (id: JobId) {
    const job = yield* repo.change(id, { _tag: "Cancel" });
    if (active?.id === id) yield* Fiber.interrupt(active.fiber);
    return job;
  });
  const resume = Effect.fn("Runner.resume")(function* (id: JobId, retryAmbiguous: boolean = false) {
    const job = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const updated = yield* repo.change(id, { _tag: "Resume" });
          yield* sql`INSERT INTO job_options VALUES (${id},${retryAmbiguous ? 1 : 0}) ON CONFLICT(job_id) DO UPDATE SET retry_ambiguous=excluded.retry_ambiguous`.pipe(
            persistence("resume"),
          );
          yield* sql`DELETE FROM retry_permissions WHERE job_id=${id}`.pipe(persistence("resume"));
          if (retryAmbiguous)
            yield* sql`INSERT INTO retry_permissions SELECT ${id},id FROM llm_attempts WHERE state='Ambiguous'`.pipe(
              persistence("resume"),
            );
          return updated;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(Conflict)(cause) ||
          Schema.is(NotFound)(cause) ||
          Schema.is(PersistenceError)(cause)
            ? cause
            : new PersistenceError({ operation: "resume", message: String(cause) }),
        ),
      );
    yield* notify;
    return job;
  });
  return { start, notify, cancel, resume };
});
export class Runner extends Context.Service<Runner, Effect.Success<typeof makeRunner>>()(
  "@tcc/server/jobs/runner",
) {}
export const runnerLayer = Layer.effect(Runner, makeRunner);
