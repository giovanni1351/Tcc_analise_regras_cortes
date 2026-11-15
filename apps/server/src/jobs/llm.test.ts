import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { StageRunKey } from "@tcc/contracts";
import { BlobStore, OpenRouter } from "../services.ts";
import { attemptLedgerLayer } from "../llm/ledger.ts";
import { fixtureServices } from "./fixtures.testkit.ts";
import { Repository } from "./repository.ts";
import { Sources } from "./sources.ts";
import { LlmStep } from "./stages.ts";
import { llmStepLayer } from "./llm.ts";

it.effect(
  "answered attempts are reused across paying jobs even without a finished verdict artifact",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/source.bin`;
      yield* fs.writeFileString(path, "video");
      let calls = 0;
      const external = Layer.succeed(OpenRouter, {
        complete: () =>
          Effect.sync(() => {
            calls++;
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
              costUsd: 0,
              latencyMs: 1,
            };
          }),
      });
      const services = fixtureServices(dir);
      const llm = llmStepLayer(0).pipe(
        Layer.provideMerge(attemptLedgerLayer.pipe(Layer.provideMerge(services))),
        Layer.provide(external),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = yield* (yield* Sources).register({ _tag: "LocalFile", path });
        const repo = yield* Repository;
        const first = yield* repo.create(source.id);
        const second = yield* repo.create(source.id, undefined, true);
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
        const blobs = yield* BlobStore;
        const temp = yield* blobs.tempPath("bin");
        yield* fs.writeFileString(temp, "video");
        yield* blobs.publish(temp, "bin");
        const media = yield* (yield* Sources).check(source.id, "verdicts");
        const step = yield* LlmStep;
        for (const [index, job] of [first, second].entries()) {
          if (index === 1) {
            yield* sql`INSERT INTO segments VALUES ('segment2',${key},'window',${source.mediaHash},0,20)`;
            const original = yield* fs.readFileString(artifactPath);
            yield* fs.writeFileString(
              artifactPath,
              original.replace('"id":"segment"', '"id":"segment2"'),
            );
          }
          const result = yield* step.run(
            {
              job,
              media,
              inputs: [{ stage: "segments", key, artifactPath }],
              retryAmbiguous: false,
              progress: () => Effect.void,
            },
            index === 0 ? key : yield* Schema.decodeEffect(StageRunKey)("b".repeat(64)),
          );
          assert.strictEqual(result.coverage?.valid, 1);
        }
        assert.strictEqual(calls, 1);
        const rows = yield* sql<{
          job_id: string;
          state: string;
        }>`SELECT job_id,state FROM llm_attempts`;
        assert.deepStrictEqual(
          rows.map((r) => ({ ...r })),
          [{ job_id: first.id, state: "Answered" }],
        );
      }).pipe(Effect.provide(llm));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
