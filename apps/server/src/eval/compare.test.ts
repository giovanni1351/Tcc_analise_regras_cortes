import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { targetEventClasses } from "@tcc/contracts";
import { databaseLayer } from "../database.ts";
import { repositoryLayer } from "../jobs/repository.ts";
import { llmStepLayer } from "../jobs/llm.ts";
import { attemptLedgerLayer } from "../llm/ledger.ts";
import { freeModelLimiterLayer } from "../llm/limiter.ts";
import { openRouterLayer } from "../llm/openrouter.ts";
import { blobStoreLayer, mediaProbeLayer, commandOutput } from "../media/index.ts";
import { processLayer } from "../process.ts";
import { Comparison, comparisonLayer } from "./compare-run.ts";
import {
  comparisonModel,
  pairedBootstrap,
  selectStratified,
  type BenchmarkRow,
} from "./compare.ts";

const row = (id: string, stratum: string): BenchmarkRow => ({
  run_id: "run",
  segment_id: id,
  selection_stratum: stratum,
  response_text: '{"segment_kind":"Non-highlight","events":[]}',
  start_seconds: 0,
  end_seconds: 1,
  source_video_path: "fixture.mp4",
  target_events_json: "[]",
  include_hidden: 0,
  cost_usd: 0.001,
});
it.effect("selects deterministically across classes and negatives independent of input order", () =>
  Effect.sync(() => {
    const strata = [...targetEventClasses, "Non-highlight"];
    const rows = strata.flatMap((s) => Array.from({ length: 30 }, (_, i) => row(`${s}:${i}`, s)));
    const selected = selectStratified(rows, 100);
    assert.deepStrictEqual(selected, selectStratified(rows.toReversed(), 100));
    assert.strictEqual(new Set(selected.map((r) => r.segment_id)).size, 100);
    assert.deepStrictEqual(
      [...new Set(selected.map((r) => r.selection_stratum))].sort(),
      strata.sort(),
    );
    const sizes = strata.map((s) => selected.filter((r) => r.selection_stratum === s).length);
    assert.isAtMost(Math.max(...sizes) - Math.min(...sizes), 1);
    assert.throws(() => selectStratified(rows, 5), RangeError);
  }),
);
it.effect("paired bootstrap agrees with the four hand-computed two-segment resamples", () =>
  Effect.sync(() => {
    const hit = { tp: 1, fp: 0, fn: 0 };
    const miss = { tp: 0, fp: 0, fn: 1 };
    const pairs = [
      { glm: hit, baseline: miss },
      { glm: miss, baseline: hit },
    ];
    const result = pairedBootstrap(pairs);
    assert.deepStrictEqual(result, {
      deltaF1: 0,
      lower: -1,
      upper: 1,
      resamples: 10_000,
      seed: 11011,
    });
    assert.deepStrictEqual(result, pairedBootstrap(pairs));
    assert.deepStrictEqual(pairedBootstrap([{ glm: hit, baseline: miss }]), {
      ...result,
      deltaF1: 1,
      lower: 1,
      upper: 1,
    });
  }),
);
it.live(
  "comparison reruns reuse Answered verdicts through the real ledger and provider service",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const video = `${dir}/fixture.mp4`;
      yield* commandOutput("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x32:r=10:d=1",
        "-c:v",
        "libx264",
        video,
      ]).pipe(Effect.provide(processLayer));
      let calls = 0;
      const http = HttpClient.make((request) => {
        calls++;
        assert.strictEqual(request.url, "https://openrouter.ai/api/v1/chat/completions");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: row("s", "Non-highlight").response_text },
                  },
                ],
                usage: { cost: 0.001 },
              }),
            ),
          ),
        );
      });
      const database = databaseLayer(`${dir}/data.sqlite`);
      const media = Layer.mergeAll(blobStoreLayer(dir), mediaProbeLayer).pipe(
        Layer.provideMerge(processLayer),
      );
      const provider = openRouterLayer("test-key").pipe(
        Layer.provide(freeModelLimiterLayer()),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      );
      const llm = llmStepLayer(1).pipe(
        Layer.provideMerge(attemptLedgerLayer.pipe(Layer.provideMerge(database))),
        Layer.provideMerge(media),
        Layer.provide(provider),
      );
      const services = comparisonLayer.pipe(
        Layer.provideMerge(llm),
        Layer.provide(repositoryLayer.pipe(Layer.provide(database))),
      );
      yield* Effect.gen(function* () {
        const service = yield* Comparison;
        const rows = [{ ...row("s", "Non-highlight"), source_video_path: video }];
        const options = {
          dryRun: false,
          retryAmbiguous: false,
          budget: 1,
          fallbackRate: 0.001,
          outputRate: 0.00001,
        };
        yield* service.run(rows, { ...options, dryRun: true });
        assert.strictEqual(calls, 0);
        const first = yield* service.run(rows, options);
        const second = yield* service.run(rows, options);
        assert.isTrue("glm" in first);
        assert.isTrue("glm" in second);
        if ("glm" in first && "glm" in second) {
          assert.strictEqual(first.glm.validOutputRate, 1);
          assert.deepStrictEqual(first.glm, first.baseline);
          assert.strictEqual(first.chargedThisRunUsd, 0.001);
          assert.strictEqual(second.chargedThisRunUsd, 0);
          assert.deepStrictEqual(second.glm, first.glm);
        }
        assert.strictEqual(calls, 1);
        const sql = yield* SqlClient.SqlClient;
        const attempts = yield* sql<{
          state: string;
          cost_usd: number;
        }>`SELECT state,cost_usd FROM llm_attempts WHERE model=${comparisonModel}`;
        assert.deepStrictEqual(
          attempts.map((r) => ({ ...r })),
          [{ state: "Answered", cost_usd: 0.001 }],
        );
        yield* sql`UPDATE llm_attempts SET state='Sent',verdict_json=NULL,cost_usd=NULL`;
        yield* service.run(rows, options);
        assert.strictEqual(calls, 1);
        const recovered = yield* sql<{ state: string }>`SELECT state FROM llm_attempts`;
        assert.strictEqual(recovered[0]?.state, "Ambiguous");
        yield* service.run(rows, { ...options, retryAmbiguous: true });
        assert.strictEqual(calls, 2);
        yield* service.run(
          [
            {
              ...rows[0],
              ...row("other", "Non-highlight"),
              source_video_path: video,
              start_seconds: 0.1,
            },
          ],
          { ...options, budget: 0 },
        );
        assert.strictEqual(calls, 2);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
