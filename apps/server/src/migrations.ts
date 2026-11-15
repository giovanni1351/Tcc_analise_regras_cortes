import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteMigrator } from "@effect/sql-sqlite-node";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(
    `CREATE TABLE media (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, probe_json TEXT NOT NULL)`,
  );
  yield* sql.unsafe(
    `CREATE TABLE sources (id TEXT PRIMARY KEY, ref_json TEXT NOT NULL, media_hash TEXT NOT NULL REFERENCES media(sha256), size INTEGER NOT NULL, mtime_ms REAL NOT NULL)`,
  );
  yield* sql.unsafe(
    `CREATE TABLE jobs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), spec_hash TEXT NOT NULL, spec_json TEXT NOT NULL, state_json TEXT NOT NULL, status TEXT NOT NULL, force INTEGER NOT NULL DEFAULT 0 CHECK(force IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX jobs_source_spec ON jobs(source_id,spec_hash) WHERE force = 0`,
  );
  yield* sql.unsafe(`CREATE INDEX jobs_status_created ON jobs(status,created_at)`);
  yield* sql.unsafe(
    `CREATE TABLE stage_runs (key TEXT PRIMARY KEY, stage TEXT NOT NULL, version TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, finished_at TEXT, device TEXT, error_json TEXT, artifact_hash TEXT)`,
  );
  yield* sql.unsafe(
    `CREATE TABLE job_stages (job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL, stage_run_key TEXT NOT NULL REFERENCES stage_runs(key), PRIMARY KEY(job_id,stage))`,
  );
  yield* sql.unsafe(`CREATE INDEX job_stages_run ON job_stages(stage_run_key)`);
  yield* sql.unsafe(
    `CREATE TABLE scenes (stage_run_key TEXT NOT NULL REFERENCES stage_runs(key), scene_id INTEGER NOT NULL, start_frame INTEGER NOT NULL, end_frame INTEGER NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, PRIMARY KEY(stage_run_key,scene_id))`,
  );
  yield* sql.unsafe(
    `CREATE TABLE samples (stage_run_key TEXT NOT NULL REFERENCES stage_runs(key), frame_index INTEGER NOT NULL, scene_id INTEGER, time_sec REAL NOT NULL, counts_json TEXT NOT NULL, PRIMARY KEY(stage_run_key,frame_index))`,
  );
  yield* sql.unsafe(`CREATE INDEX samples_run_time ON samples(stage_run_key,time_sec)`);
  yield* sql.unsafe(
    `CREATE TABLE windows (id TEXT PRIMARY KEY, stage_run_key TEXT NOT NULL REFERENCES stage_runs(key), start_sec REAL NOT NULL, end_sec REAL NOT NULL, anchors_json TEXT NOT NULL)`,
  );
  yield* sql.unsafe(`CREATE INDEX windows_run ON windows(stage_run_key)`);
  yield* sql.unsafe(
    `CREATE TABLE segments (id TEXT PRIMARY KEY, stage_run_key TEXT NOT NULL REFERENCES stage_runs(key), window_id TEXT NOT NULL REFERENCES windows(id), blob_hash TEXT NOT NULL, clip_start_sec REAL NOT NULL, duration_sec REAL NOT NULL)`,
  );
  yield* sql.unsafe(`CREATE INDEX segments_run ON segments(stage_run_key)`);
  yield* sql.unsafe(
    `CREATE TABLE llm_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), segment_id TEXT NOT NULL REFERENCES segments(id), model TEXT NOT NULL, prompt_version TEXT NOT NULL, attempt_number INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('Reserved','Sent','Answered','Failed','Ambiguous')), reserved_usd REAL NOT NULL CHECK(reserved_usd >= 0), cost_usd REAL CHECK(cost_usd >= 0), http_status INTEGER, response_json TEXT, verdict_json TEXT, parse_error_json TEXT, usage_json TEXT, generation_id TEXT, latency_ms REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(segment_id,model,prompt_version,attempt_number))`,
  );
  yield* sql.unsafe(`CREATE INDEX attempts_job_state ON llm_attempts(job_id,state)`);
  yield* sql.unsafe(
    `CREATE TABLE highlights (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), class TEXT NOT NULL, half INTEGER CHECK(half IN (1,2)), video_seconds REAL NOT NULL, confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), segment_id TEXT NOT NULL REFERENCES segments(id), attempt_id TEXT NOT NULL REFERENCES llm_attempts(id), clip_blob_hash TEXT)`,
  );
  yield* sql.unsafe(`CREATE INDEX highlights_job_time ON highlights(job_id,video_seconds)`);
});
export const migrate = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "001_initial": initial,
    "002_job_options": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE stage_runs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'`;
      yield* sql`CREATE UNIQUE INDEX sources_media ON sources(media_hash)`;
      yield* sql`CREATE TABLE job_options (job_id TEXT PRIMARY KEY REFERENCES jobs(id), retry_ambiguous INTEGER NOT NULL DEFAULT 0)`;
    }),
  }),
});
