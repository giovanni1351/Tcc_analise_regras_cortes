import { heldReservationSql } from "../llm/accounting.ts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SecureRandom } from "effect/crypto";
import {
  Conflict,
  Coverage,
  Job,
  JobId,
  JobResult,
  JobSpec,
  JobState,
  NotFound,
  PersistenceError,
  Source,
  SourceId,
  SourceRef,
  Probe,
  type MediaHash,
  defaultRuleConfig,
} from "@tcc/contracts";
import { canonicalJson, stageKey } from "./keys.ts";
import { move, type JobEvent } from "./state.ts";

export const emptyCoverage = {
  segments: 0,
  valid: 0,
  invalid: 0,
  ambiguous: 0,
  notSent: 0,
} satisfies Coverage;
export const defaultSpec = {
  rule: defaultRuleConfig,
  llm: {
    model: "nvidia/nemotron-3.5-super-vl:free",
    promptVersion: "benchmark-v1",
    maxCostUsd: 0.1,
  },
  clips: true,
} satisfies JobSpec;
export const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
export const newId = Effect.sync(() => SecureRandom.uuidV4Unsafe());
export const persistence = (operation: string) =>
  Effect.mapError((cause: unknown) => new PersistenceError({ operation, message: String(cause) }));

export const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const source = Effect.fn("Sources.get")(function* (id: SourceId) {
    const rows = yield* sql<{
      id: string;
      ref_json: string;
      media_hash: string;
      probe_json: string;
    }>`SELECT s.*, m.probe_json FROM sources s JOIN media m ON m.sha256=s.media_hash WHERE s.id=${id}`.pipe(
      persistence("getSource"),
    );
    const row = rows[0];
    if (!row) return yield* new NotFound({ resource: "source", id });
    const ref = yield* Schema.decodeEffect(Schema.fromJsonString(SourceRef))(row.ref_json).pipe(
      persistence("decodeSourceRef"),
    );
    const probe = yield* Schema.decodeEffect(Schema.fromJsonString(Probe))(row.probe_json).pipe(
      persistence("decodeProbe"),
    );
    return yield* Schema.decodeEffect(Source)({
      id: row.id,
      ref,
      mediaHash: row.media_hash,
      probe,
    }).pipe(persistence("decodeSource"));
  });
  const job = Effect.fn("Jobs.get")(function* (id: JobId) {
    const rows = yield* sql<{
      source_id: string;
      spec_json: string;
      state_json: string;
      created_at: string;
      updated_at: string;
    }>`SELECT * FROM jobs WHERE id=${id}`.pipe(persistence("getJob"));
    const row = rows[0];
    if (!row) return yield* new NotFound({ resource: "job", id });
    const stages =
      yield* sql`SELECT r.stage,r.key,r.device, CASE WHEN r.status='Finished' THEN 1 WHEN json_extract(b.state_json,'$._tag')='Running' AND json_extract(b.state_json,'$.stage')=r.stage THEN json_extract(b.state_json,'$.done') ELSE 0 END AS done,CASE WHEN r.status!='Finished' AND json_extract(b.state_json,'$._tag')='Running' AND json_extract(b.state_json,'$.stage')=r.stage THEN json_extract(b.state_json,'$.total') ELSE 1 END AS total FROM job_stages j JOIN stage_runs r ON r.key=j.stage_run_key JOIN jobs b ON b.id=j.job_id WHERE j.job_id=${id}`.pipe(
        persistence("jobStages"),
      );
    const cost =
      yield* sql`SELECT COALESCE(SUM(cost_usd),0) AS committedUsd, ${sql.literal(heldReservationSql)} AS reservedUsd FROM llm_attempts WHERE job_id=${id}`.pipe(
        persistence("jobCost"),
      );
    const state = yield* Schema.decodeEffect(Schema.fromJsonString(JobState))(row.state_json).pipe(
      persistence("decodeState"),
    );
    const spec = yield* Schema.decodeEffect(Schema.fromJsonString(JobSpec))(row.spec_json).pipe(
      persistence("decodeSpec"),
    );
    return yield* Schema.decodeUnknownEffect(Job)({
      id,
      sourceId: row.source_id,
      spec,
      state,
      stages,
      coverage: "coverage" in state ? state.coverage : emptyCoverage,
      ...cost[0],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }).pipe(persistence("decodeJob"));
  });
  const change = Effect.fn("Jobs.change")((id: JobId, event: JobEvent) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* job(id);
          const state = yield* move(current.state, event);
          const timestamp = yield* now;
          yield* sql`UPDATE jobs SET state_json=${JSON.stringify(state)},status=${state._tag},updated_at=${timestamp} WHERE id=${id}`.pipe(
            persistence("changeJob"),
          );
          return yield* job(id);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(Conflict)(cause) ||
          Schema.is(NotFound)(cause) ||
          Schema.is(PersistenceError)(cause)
            ? cause
            : new PersistenceError({ operation: "changeJob", message: String(cause) }),
        ),
      ),
  );
  const create = Effect.fn("Jobs.create")(function* (
    sourceId: SourceId,
    spec: JobSpec = defaultSpec,
    force: boolean = false,
  ) {
    yield* source(sourceId);
    const hash = yield* stageKey("spec", "1", spec, []).pipe(persistence("specHash"));
    const id = yield* newId.pipe(Effect.flatMap(Schema.decodeEffect(JobId)), persistence("jobId"));
    const state = yield* move(null, { _tag: "Create" });
    const timestamp = yield* now;
    yield* sql`INSERT OR IGNORE INTO jobs (id,source_id,spec_hash,spec_json,state_json,status,force,created_at,updated_at) VALUES (${id},${sourceId},${hash},${JSON.stringify(spec)},${JSON.stringify(state)},${state._tag},${force ? 1 : 0},${timestamp},${timestamp})`.pipe(
      persistence("createJob"),
    );
    if (force) return yield* job(id);
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM jobs WHERE source_id=${sourceId} AND spec_hash=${hash} AND force=0`.pipe(
      persistence("findJob"),
    );
    const existing = yield* Schema.decodeUnknownEffect(JobId)(rows[0]?.id).pipe(
      persistence("findJob"),
    );
    return yield* job(existing);
  });
  const list = Effect.fn("Jobs.list")(function* (
    offset: number = 0,
    limit: number = 50,
    state?: JobState["_tag"],
  ) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return yield* new Conflict({
        operation: "listJobs",
        message: "offset must be nonnegative and limit between 1 and 100",
      });
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM jobs WHERE (${state ?? null} IS NULL OR status=${state ?? null}) ORDER BY created_at,id LIMIT ${limit} OFFSET ${offset}`.pipe(
      persistence("listJobs"),
    );
    const count = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM jobs WHERE (${state ?? null} IS NULL OR status=${state ?? null})`.pipe(
      persistence("countJobs"),
    );
    const jobs = yield* Effect.forEach(rows, (row) =>
      Schema.decodeEffect(JobId)(row.id).pipe(persistence("jobId"), Effect.flatMap(job)),
    );
    return { jobs, total: count[0]?.total ?? 0 };
  });
  const result = Effect.fn("Jobs.result")(function* (id: JobId) {
    const current = yield* job(id);
    const highlights =
      yield* sql`SELECT id,class,half,video_seconds AS videoSeconds,confidence,segment_id AS segmentId,attempt_id AS attemptId,CASE WHEN clip_blob_hash IS NULL THEN NULL ELSE '/blobs/' || clip_blob_hash END AS clipUrl FROM highlights WHERE job_id=${id} ORDER BY video_seconds,id`.pipe(
        persistence("result"),
      );
    return yield* Schema.decodeUnknownEffect(JobResult)({
      jobId: id,
      highlights,
      coverage: current.coverage,
    }).pipe(persistence("decodeResult"));
  });
  const register = Effect.fn("Sources.insert")(function* (
    ref: SourceRef,
    hash: MediaHash,
    probe: Source["probe"],
    size: number,
    mtime: number,
  ) {
    const existing = yield* sql<{
      id: string;
    }>`SELECT id FROM sources WHERE ref_json=${canonicalJson(ref)} LIMIT 1`.pipe(
      persistence("findSource"),
    );
    if (existing[0])
      return yield* source(
        yield* Schema.decodeEffect(SourceId)(existing[0].id).pipe(persistence("sourceId")),
      );
    const id = yield* newId.pipe(
      Effect.flatMap(Schema.decodeEffect(SourceId)),
      persistence("sourceId"),
    );
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO media VALUES (${hash},${size},${JSON.stringify(probe)})`;
          yield* sql`INSERT OR IGNORE INTO sources VALUES (${id},${canonicalJson(ref)},${hash},${size},${mtime})`;
        }),
      )
      .pipe(persistence("registerSource"));
    const registered = yield* sql<{
      id: string;
    }>`SELECT id FROM sources WHERE ref_json=${canonicalJson(ref)} LIMIT 1`.pipe(
      persistence("registeredSource"),
    );
    return yield* source(
      yield* Schema.decodeUnknownEffect(SourceId)(registered[0]?.id).pipe(
        persistence("registeredSource"),
      ),
    );
  });
  const recover = Effect.fn("Jobs.recover")(function* () {
    const rows = yield* sql<{ id: string }>`SELECT id FROM jobs WHERE status='Running'`.pipe(
      persistence("recover"),
    );
    for (const row of rows)
      yield* change(yield* Schema.decodeEffect(JobId)(row.id).pipe(persistence("jobId")), {
        _tag: "Recover",
      });
    yield* sql`UPDATE llm_attempts SET state='Ambiguous' WHERE state='Sent'`.pipe(
      persistence("recoverAttempts"),
    );
  });
  const claim = Effect.fn("Jobs.claim")(() =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM jobs WHERE status='Queued' ORDER BY created_at,id LIMIT 1`.pipe(
            persistence("claim"),
          );
          if (!rows[0]) return null;
          return yield* change(
            yield* Schema.decodeEffect(JobId)(rows[0].id).pipe(persistence("jobId")),
            { _tag: "Start" },
          );
        }),
      )
      .pipe(persistence("claim")),
  );
  return { source, job, change, create, list, result, register, recover, claim };
});
export class Repository extends Context.Service<
  Repository,
  Effect.Success<typeof makeRepository>
>()("@tcc/server/jobs/repository") {}
export const repositoryLayer = Layer.effect(Repository, makeRepository);
