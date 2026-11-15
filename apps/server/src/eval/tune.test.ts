import { gzipSync } from "node:zlib";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { defaultRuleConfig, JobId } from "@tcc/contracts";
import { defaultSpec, emptyCoverage } from "../jobs/repository.ts";
import { makeEvaluationClient } from "./score-job.ts";
import { makeTunePlan, parseGrid, runTune, waitForJob, pairedBootstrap } from "./tune.ts";
import { computeWindows } from "../domain/rules.ts";
import { planSegments } from "../domain/segments.ts";
import { studyInputs, type StudyVideo } from "./rules.ts";

const options = {
  studyDir: new URL("./fixtures/missing-study", import.meta.url).pathname,
  halves: 2,
  model: "example:free",
  grid: "40/5,20/4",
  maxUsd: 0,
  usdPerSecond: null,
};
it.effect("plans deterministic paired train halves and requires paid pricing", () =>
  Effect.gen(function* () {
    const plan = yield* makeTunePlan(options);
    assert.deepStrictEqual(plan, yield* makeTunePlan(options));
    assert.strictEqual(plan.jobs.length, 4);
    assert.deepStrictEqual(plan.jobs[0]?.half, plan.jobs[2]?.half);
    assert.strictEqual(plan.estimatedUsd, 0);
    yield* makeTunePlan({ ...options, model: "paid/model" }).pipe(Effect.flip);
    assert.throws(() => parseGrid("20/10"));
    yield* makeTunePlan({ ...options, halves: 0 }).pipe(Effect.flip);
    const paid = yield* makeTunePlan({ ...options, model: "paid/model", usdPerCall: 0.01 });
    assert.strictEqual(paid.admitted, false);
    assert.ok(paid.estimatedUsd > 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

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
    const plan = yield* makeTunePlan(options);
    const result = yield* runTune(
      client,
      plan,
      { dryRun: true, includeNotShown: false },
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { plan });
    const refusal = yield* runTune(
      client,
      yield* makeTunePlan({ ...options, model: "paid/model", usdPerCall: 0.01 }),
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

it.effect("held-out evaluation requires one frozen configuration", () =>
  Effect.gen(function* () {
    yield* makeTunePlan({ ...options, split: "test" }).pipe(Effect.flip);
    const plan = yield* makeTunePlan({ ...options, split: "test", grid: "30/5" });
    assert.strictEqual(plan.split, "test");
    assert.strictEqual(plan.jobs.length, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

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
    const plan = yield* makeTunePlan({ ...options, split: "test", halves: 1, grid: "30/5" });
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

it.effect("prices the rule's planned segments and labels missing exports as upper bounds", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const half = (yield* makeTunePlan(options)).jobs[0]!.half;
    const video: StudyVideo = {
      video_id: "fixture",
      metadata: {
        competition: half.league,
        season: half.season,
        game: half.game,
        half: half.half,
        height: Number.parseInt(half.resolution),
        duration_sec: 150,
        fps: 25,
        yolo_stride: 25,
      },
      scenes: [
        { scene_id: 0, start_sec: 0, duration_sec: 20 },
        { scene_id: 1, start_sec: 20, duration_sec: 5 },
        { scene_id: 2, start_sec: 25, duration_sec: 125 },
      ],
      samples: [
        ...[5, 10, 15].map((time_sec) => ({ scene_id: 0, time_sec, player_count: 8 })),
        ...[20, 21, 22].map((time_sec) => ({ scene_id: 1, time_sec, player_count: 0 })),
        { scene_id: 2, time_sec: 149, player_count: 8 },
      ],
      events: [],
    };
    yield* fs.writeFileString(
      `${directory}/manifest.json`,
      JSON.stringify({ files: ["fixture.json.gz", "missing.json.gz"] }),
    );
    yield* fs.writeFile(`${directory}/fixture.json.gz`, gzipSync(JSON.stringify(video)));
    const paidOptions = {
      ...options,
      studyDir: directory,
      model: "paid/model",
      usdPerCall: 0.0013,
      maxUsd: 10,
    };
    const plan = yield* makeTunePlan(paidOptions);
    const { scenes, samples, meta } = studyInputs(video);
    const windows = computeWindows(scenes, samples, meta, defaultRuleConfig);
    assert.strictEqual(windows.length, 1);
    for (const job of plan.jobs) {
      if (job.half.workbook === half.workbook) {
        const segments = planSegments(windows, job.segmentation);
        assert.strictEqual(job.segments, segments.length);
        assert.strictEqual(job.estimate, "study windows");
        assert.strictEqual(job.estimatedUsd, segments.length * paidOptions.usdPerCall);
        const seconds = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
        assert.strictEqual(job.durationSec, seconds);
        const perSecond = yield* makeTunePlan({
          ...options,
          studyDir: directory,
          model: "paid/model",
          maxUsd: 10,
          usdPerSecond: 0.002,
        });
        assert.strictEqual(
          perSecond.jobs.find(
            (j) => j.half === job.half && j.segmentation.maxSec === job.segmentation.maxSec,
          )?.estimatedUsd,
          seconds * 0.002,
        );
      } else {
        assert.strictEqual(job.estimate, "upper bound");
        assert.strictEqual(
          job.segments,
          Math.ceil(job.half.duration / (job.segmentation.maxSec - job.segmentation.overlapSec)) +
            job.half.scenes,
        );
      }
    }
    assert.strictEqual(plan.jobs[0]!.segments, 1);
    assert.strictEqual(plan.jobs[2]!.segments, 2);
    assert.strictEqual(
      (yield* makeTunePlan({ ...paidOptions, maxUsd: plan.estimatedUsd })).admitted,
      true,
    );
    const refused = yield* makeTunePlan({ ...paidOptions, maxUsd: plan.estimatedUsd - 0.0001 });
    assert.strictEqual(refused.admitted, false);
    const http = HttpClient.make(() => Effect.die("Refused plan sent an HTTP request"));
    const client = (yield* makeEvaluationClient(3000).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )).highlights;
    const error = yield* runTune(
      client,
      refused,
      { dryRun: true, includeNotShown: false },
      () => Effect.void,
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "EvaluationError");
    if (error._tag === "EvaluationError") assert.strictEqual(error.operation, "admit");
    yield* fs.remove(`${directory}/fixture.json.gz`);
    assert.ok(
      (yield* makeTunePlan(paidOptions)).jobs.every((job) => job.estimate === "upper bound"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
