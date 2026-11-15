import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { StageRunKey } from "@tcc/contracts";
import { BlobStore, OpenRouter, ProviderError } from "../services.ts";
import { attemptLedgerLayer } from "../llm/ledger.ts";
import { fixtureServices } from "./fixtures.testkit.ts";
import { defaultSpec, Repository } from "./repository.ts";
import { Runner } from "./runner.ts";
import { Sources } from "./sources.ts";
import { LlmStep } from "./stages.ts";
import { llmStepLayer } from "./llm.ts";

for (const state of [
  "Answered",
  "Sent",
  "Ambiguous",
  "Interrupted",
  "Recovery",
  "Daily",
  "Credit",
  "ReplyCancelled",
] as const)
  it.effect(`clips with ${state} attempts are protected across jobs and segment ids`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/source.bin`;
      yield* fs.writeFileString(path, "video");
      let calls = 0;
      const started = yield* Deferred.make<void>();
      const external = Layer.succeed(OpenRouter, {
        complete: () =>
          Effect.gen(function* () {
            calls++;
            if (state === "Daily")
              return yield* new ProviderError({
                category: "RateLimited",
                httpStatus: null,
                retryAfterMs: 86_400_000,
                message: "Free model day limit",
                sent: false,
                quotaPeriod: "day",
              });
            if (state === "Credit")
              return yield* new ProviderError({
                category: "CreditExhausted",
                httpStatus: 402,
                retryAfterMs: null,
                message: "This request requires at least $1.00 in balance for video",
              });

            yield* Deferred.succeed(started, undefined);
            if (state === "Interrupted" || state === "Recovery") return yield* Effect.never;
            const caller = yield* Effect.fiber;
            return {
              httpStatus: 200,
              body: {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ segment_kind: "Non-highlight", events: [] }),
                    },
                  },
                ],
              },
              generationId: "gen-fixture",
              get costUsd() {
                if (state === "ReplyCancelled") caller.interruptUnsafe(caller.id);
                return 0;
              },
              latencyMs: 1,
            };
          }),
      });
      const services = fixtureServices(dir);
      const llm = llmStepLayer(10).pipe(
        Layer.provideMerge(attemptLedgerLayer.pipe(Layer.provideMerge(services))),
        Layer.provide(external),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = yield* (yield* Sources).register({ _tag: "LocalFile", path });
        const repo = yield* Repository;
        const first = yield* repo.create(source.id, {
          ...defaultSpec,
          llm: { ...defaultSpec.llm, model: "paid", maxCostUsd: 10 },
        });
        const second = yield* repo.create(source.id, first.spec, true);
        const key = yield* Schema.decodeEffect(StageRunKey)("a".repeat(64));
        yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES (${key},'verdicts','test','{}','Running')`;
        yield* sql`INSERT INTO windows VALUES ('window',${key},0,20,'[]')`;
        yield* sql`INSERT INTO segments VALUES ('segment',${key},'window',${source.mediaHash},0,20)`;
        const artifactPath = `${dir}/segments.json`;
        yield* fs.writeFileString(
          artifactPath,
          JSON.stringify([
            {
              id: "segment",
              windowId: "window",
              windowIndex: 0,
              start: 0,
              end: 20,
              blob: source.mediaHash,
              clipStart: 0,
              durationSec: 20,
            },
          ]),
        );
        if (state === "Daily" || state === "Credit") {
          yield* sql`INSERT INTO segments VALUES ('remaining',${key},'window',${source.mediaHash},0,20)`;
          const text = yield* fs.readFileString(artifactPath);
          yield* fs.writeFileString(
            artifactPath,
            text.slice(0, -1) +
              "," +
              text.slice(1, -1).replace('"id":"segment"', '"id":"remaining"') +
              "]",
          );
        }
        const blobs = yield* BlobStore;
        const temp = yield* blobs.tempPath("bin");
        yield* fs.writeFileString(temp, "video");
        yield* blobs.publish(temp, "bin");
        if (state === "Recovery") {
          yield* repo.change(first.id, { _tag: "Start" });
          yield* repo.change(first.id, {
            _tag: "Complete",
            state: {
              _tag: "Partial",
              coverage: { segments: 1, valid: 0, invalid: 0, ambiguous: 1, notSent: 0 },
              reason: { _tag: "AmbiguousAttempts", count: 1 },
            },
          });
          yield* sql`INSERT INTO llm_attempts (id,job_id,segment_id,model,prompt_version,attempt_number,state,reserved_usd,created_at,updated_at) VALUES ('old',${first.id},'segment','paid',${first.spec.llm.promptVersion},1,'Ambiguous',0,'old','old')`;
          yield* (yield* Runner).resume(first.id, true);
          yield* repo.claim();
        }
        const media = yield* (yield* Sources).check(source.id, "verdicts");
        const step = yield* LlmStep;
        for (const [index, job] of [first, state === "Recovery" ? first : second].entries()) {
          if (index === 1) {
            yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','verdicts','test','{}','Running')`;
            yield* sql`INSERT INTO segments VALUES ('segment2',${key},'window',${source.mediaHash},0,20)`;
            const original = yield* fs.readFileString(artifactPath);
            yield* fs.writeFileString(
              artifactPath,
              original.replace('"id":"segment"', '"id":"segment2"'),
            );
          }
          const run = step.run(
            {
              job,
              media,
              inputs: [{ stage: "segments", key, artifactPath }],
              retryAmbiguous:
                state === "Recovery" &&
                (yield* sql<{
                  retry_ambiguous: number;
                }>`SELECT retry_ambiguous FROM job_options WHERE job_id=${first.id}`)[0]
                  ?.retry_ambiguous === 1,
              progress: () => Effect.void,
            },
            index === 0 ? key : yield* Schema.decodeEffect(StageRunKey)("b".repeat(64)),
          );
          if (index === 0 && state === "ReplyCancelled") {
            yield* Effect.forkChild(run).pipe(Effect.flatMap(Fiber.await));
          } else if (index === 0 && (state === "Interrupted" || state === "Recovery")) {
            const fiber = yield* Effect.forkChild(run);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            if (state === "Recovery") {
              yield* sql`UPDATE llm_attempts SET state='Sent' WHERE id<>'old'`;
              yield* repo.recover();
              assert.strictEqual(
                (yield* sql<{
                  retry_ambiguous: number;
                }>`SELECT retry_ambiguous FROM job_options WHERE job_id=${first.id}`)[0]
                  ?.retry_ambiguous,
                0,
              );
            }
          } else {
            const result = yield* run;
            if (state === "Daily")
              assert.deepStrictEqual(result.partial, {
                _tag: "FreeDailyLimit",
                retryAfterMs: 86_400_000,
              });
            if (state === "Credit")
              assert.deepStrictEqual(result.partial, {
                _tag: "CreditExhausted",
                message: "This request requires at least $1.00 in balance for video",
              });
            assert.strictEqual(
              state === "Daily" || state === "Credit"
                ? result.coverage?.notSent
                : index === 1 && state !== "Answered" && state !== "ReplyCancelled"
                  ? result.coverage?.ambiguous
                  : result.coverage?.valid,
              state === "Daily" || state === "Credit" ? 2 : 1,
            );
          }
          if (state === "Daily" || state === "Credit") break;
          if (index === 0 && (state === "Sent" || state === "Ambiguous"))
            yield* sql`UPDATE llm_attempts SET state=${state},cost_usd=NULL,verdict_json=NULL`;
        }
        assert.strictEqual(calls, 1);
        const rows = yield* sql<{
          id: string;
          job_id: string;
          state: string;
        }>`SELECT id,job_id,state FROM llm_attempts`;
        assert.deepStrictEqual(
          rows
            .filter((r) => state !== "Recovery" || r.job_id === first.id)
            .filter((r) => r.id !== "old")
            .map((r) => ({ job_id: r.job_id, state: r.state })),
          [
            {
              job_id: first.id,
              state:
                state === "ReplyCancelled"
                  ? "Answered"
                  : state === "Daily" || state === "Credit"
                    ? "Failed"
                    : state === "Interrupted" || state === "Recovery"
                      ? "Ambiguous"
                      : state,
            },
          ],
        );
      }).pipe(Effect.provide(llm));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

it.effect("job budget retains answered attempts with unknown cost", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = `${dir}/video`;
    yield* fs.writeFileString(path, "video");
    yield* Effect.gen(function* () {
      const source = yield* (yield* Sources).register({ _tag: "LocalFile", path });
      const repo = yield* Repository;
      const job = yield* repo.create(source.id);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO stage_runs (key,stage,version,params_json,status) VALUES ('run','verdicts','v1','{}','Running')`;
      yield* sql`INSERT INTO windows VALUES ('window','run',0,10,'[]')`;
      yield* sql`INSERT INTO segments VALUES ('segment','run','window',${source.mediaHash},0,10)`;
      yield* sql`INSERT INTO llm_attempts (id,job_id,segment_id,model,prompt_version,attempt_number,state,reserved_usd,created_at,updated_at) VALUES ('attempt',${job.id},'segment','paid','v1',1,'Answered',0.4,'now','now')`;
      assert.strictEqual((yield* repo.job(job.id)).reservedUsd, 0.4);
    }).pipe(Effect.provide(fixtureServices(dir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
