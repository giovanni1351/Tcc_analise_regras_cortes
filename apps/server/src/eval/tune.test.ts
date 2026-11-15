import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
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

it("held-out evaluation requires one frozen configuration", () => {
  assert.throws(() => makeTunePlan({ ...options, split: "test" }));
  const plan = makeTunePlan({ ...options, split: "test", grid: "30/5" });
  assert.strictEqual(plan.split, "test");
  assert.strictEqual(plan.jobs.length, 2);
});

it.effect("waits through queued state using the clock and returns completion", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make((request) => {
      const state =
        calls++ === 0 ? { _tag: "Queued" } : { _tag: "Succeeded", coverage: emptyCoverage };
      return Deferred.succeed(requested, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: "j",
              sourceId: "s",
              spec: defaultSpec,
              state,
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
    });
    const client = (yield* makeEvaluationClient(3000).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )).highlights;
    const fiber = yield* waitForJob(client, yield* Schema.decodeEffect(JobId)("j")).pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(requested);
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* Fiber.join(fiber)).state._tag, "Succeeded");
    assert.strictEqual(calls, 2);
  }),
);

it.effect("executes a held-out plan through HTTP and scores local half labels", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const plan = makeTunePlan({ ...options, split: "test", halves: 1, grid: "30/5" });
    const half = plan.jobs[0]!.half;
    const directory = `${root}/${half.league}/${half.season}/${half.game}`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      directory + "/Labels-v2.json",
      JSON.stringify({
        annotations: [
          { gameTime: `${half.half} - 01:00`, position: "60000", label: "Goal" },
          { gameTime: `${half.half === 1 ? 2 : 1} - 01:00`, position: "60000", label: "Goal" },
        ],
      }),
    );
    let created = 0;
    const source = {
      id: "s",
      ref: {
        _tag: "SoccerNetHalf",
        league: half.league,
        season: half.season,
        game: half.game,
        half: half.half,
        resolution: half.resolution,
      },
      mediaHash: "a".repeat(64),
      probe: { duration: half.duration, fps: 25, size: 1, frameCount: 100 },
    };
    const coverage = { ...emptyCoverage, segments: 1, valid: 1 };
    const job = {
      id: "j",
      sourceId: "s",
      spec: defaultSpec,
      state: { _tag: "Succeeded", coverage },
      stages: [],
      coverage,
      committedUsd: 0,
      reservedUsd: 0,
      createdAt: "now",
      updatedAt: "now",
    };
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      let body: unknown;
      if (url.pathname === "/sources" || url.pathname === "/sources/s") body = source;
      else if (url.pathname === "/jobs" && request.method === "POST") {
        created++;
        body = job;
      } else if (url.pathname === "/jobs/j") body = job;
      else if (url.pathname === "/jobs/j/evaluation") body = { windows: [{ start: 50, end: 80 }] };
      else if (url.pathname === "/jobs/j/result")
        body = {
          jobId: "j",
          coverage,
          highlights: [
            {
              id: "h",
              class: "Goal",
              half: half.half,
              videoSeconds: 61,
              confidence: 1,
              segmentId: "segment",
              attemptId: "a",
              clipUrl: null,
            },
          ],
        };
      else return Effect.die("Unexpected HTTP request " + request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body, {
            status: request.method === "POST" && url.pathname === "/jobs" ? 202 : 200,
          }),
        ),
      );
    });
    const client = (yield* makeEvaluationClient(3000).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )).highlights;
    const report = yield* runTune(
      client,
      plan,
      { dryRun: false, includeNotShown: false },
      () => Effect.void,
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ TCC_SOCCERNET_ROOT: root }),
      ),
    );
    assert.strictEqual(created, 1);
    assert.ok("configs" in report);
    if ("configs" in report) {
      assert.strictEqual(report.configs[0]?.f1, 1);
      assert.strictEqual(report.configs[0]?.bootstrap, null);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
