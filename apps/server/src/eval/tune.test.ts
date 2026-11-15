import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { JobId } from "@tcc/contracts";
import { defaultSpec, emptyCoverage } from "../jobs/repository.ts";
import { makeEvaluationClient } from "./score-job.ts";
import { makeTunePlan, parseGrid, runTune, waitForJob, pairedBootstrap } from "./tune.ts";

const options = {
  halves: 2,
  model: "example:free",
  grid: "40/5,20/4",
  maxUsd: 0,
  usdPerSecond: null,
};
it("plans deterministic paired train halves and requires paid pricing", () => {
  const plan = makeTunePlan(options);
  assert.deepStrictEqual(plan, makeTunePlan(options));
  assert.strictEqual(plan.jobs.length, 4);
  assert.deepStrictEqual(plan.jobs[0]?.half, plan.jobs[2]?.half);
  assert.strictEqual(plan.estimatedUsd, 0);
  assert.throws(() => makeTunePlan({ ...options, model: "paid/model" }));
  assert.throws(() => parseGrid("20/10"));
  assert.throws(() => makeTunePlan({ ...options, halves: 0 }));
  const paid = makeTunePlan({ ...options, model: "paid/model", usdPerCall: 0.01 });
  assert.strictEqual(paid.admitted, false);
  assert.ok(paid.estimatedUsd > 0);
});

it.effect("dry runs send no HTTP requests, and reject costs before creating jobs", () =>
  Effect.gen(function* () {
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
    });
    const client = (yield* makeEvaluationClient(3000).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )).highlights;
    const plan = makeTunePlan(options);
    const result = yield* runTune(
      client,
      plan,
      { dryRun: true, includeNotShown: false },
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { plan });
    const refusal = yield* runTune(
      client,
      makeTunePlan({ ...options, model: "paid/model", usdPerCall: 0.01 }),
      { dryRun: true, includeNotShown: false },
      () => Effect.void,
    ).pipe(Effect.flip);
    assert.strictEqual(refusal._tag, "EvaluationError");
    assert.strictEqual(calls, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("watching a completed job uses the generated client", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "j",
            sourceId: "s",
            spec: defaultSpec,
            state: { _tag: "Succeeded", coverage: emptyCoverage },
            stages: [],
            coverage: emptyCoverage,
            committedUsd: 0,
            reservedUsd: 0,
            createdAt: "now",
            updatedAt: "now",
          }),
        ),
      ),
    );
    const client = (yield* makeEvaluationClient(3000).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )).highlights;
    const job = yield* waitForJob(client, yield* Schema.decodeEffect(JobId)("j"));
    assert.strictEqual(job.state._tag, "Succeeded");
  }),
);
it("paired bootstrap uses halves and produces a zero interval for identical scores", () => {
  const sample = {
    jobId: Schema.decodeSync(JobId)("j"),
    source: {
      _tag: "SoccerNetHalf",
      league: "l",
      season: "s",
      game: "g",
      half: 1,
      resolution: "224p",
    } as const,
    includeNotShown: false,
    overall: { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 },
    perClass: {},
    windowShare: 0.5,
    ceiling: { labels: 2, reachable: 1, recall: 0.5 },
    coverage: emptyCoverage,
    costUsd: 0,
  };
  const result = pairedBootstrap([sample], [sample]);
  assert.strictEqual(result.lower, 0);
  assert.strictEqual(result.upper, 0);
  assert.strictEqual(result.resamples, 10000);
});
