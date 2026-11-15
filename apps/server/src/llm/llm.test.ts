import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { NodeServices } from "@effect/platform-node";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OpenRouter } from "../services.ts";
import { targetEventClasses } from "@tcc/contracts";
import { requestBody, systemPrompt, userPrompt } from "./prompt.ts";
import { openRouterLayer, classifyError, isRetryable } from "./openrouter.ts";
import { parseVerdict } from "./verdict.ts";
import { admit, reservationFor } from "./admission.ts";
import { FreeModelLimiter, freeModelLimiterLayer } from "./limiter.ts";
import errors from "../../test/fixtures/openrouter/errors.json" with { type: "json" };

import invalidCompletions from "../../test/fixtures/openrouter/invalid-completions.json" with { type: "json" };

const reply = (content: unknown, finish = "stop") => ({
  httpStatus: 200,
  body: {
    choices: [
      {
        finish_reason: finish,
        message: { content: typeof content === "string" ? content : JSON.stringify(content) },
      },
    ],
  },
  generationId: null,
  costUsd: 0,
  latencyMs: 0,
});
const empty = { segment_kind: "Non-highlight", events: [] };
it("classifies the V7 recorded errors", () => {
  for (const fixture of invalidCompletions)
    assert.strictEqual(
      parseVerdict({ ...reply(""), body: fixture.body }, 10)._tag,
      "Invalid",
      fixture.name,
    );
  for (const fixture of errors) {
    const error = classifyError(fixture.status, fixture.body, fixture.retryAfter ?? undefined, 0);
    assert.strictEqual(error.category, fixture.expected);
    assert.strictEqual(error.retryAfterMs, fixture.retryAfter === "2" ? 2000 : null);
    assert.strictEqual(
      isRetryable(error),
      [408, 425, 429, 500, 502, 503].includes(fixture.status) ||
        fixture.expected === "InFlightBudget",
    );
  }
  assert.strictEqual(
    classifyError(429, {}, "Thu, 01 Jan 1970 00:00:10 GMT", 1000).retryAfterMs,
    9000,
  );
});
it("rejects truncation, schema errors, kind inconsistency and timestamps outside the clip", () => {
  const goal = {
    event_class: "Goal",
    timestamp_seconds: 10,
    confidence: 1,
    alternate_prediction: null,
  };
  for (const invalid of [
    reply(empty, "length"),
    reply(""),
    reply("not json"),
    reply({ ...empty, extra: true }),
    reply({ segment_kind: "Non-highlight", events: [goal] }),
    reply({ segment_kind: "Single-highlight", events: [{ ...goal, timestamp_seconds: 11 }] }),
    reply({
      segment_kind: "Single-highlight",
      events: [
        {
          ...goal,
          alternate_prediction: { event_class: "Goal", timestamp_seconds: 11, confidence: 1 },
        },
      ],
    }),
  ]) {
    assert.strictEqual(parseVerdict(invalid, 10)._tag, "Invalid");
  }
  assert.strictEqual(
    parseVerdict(reply({ segment_kind: "Single-highlight", events: [goal] }), 10)._tag,
    "Valid",
  );
});
it("admits exact limits and reserves pessimistically", () => {
  assert.isTrue(
    admit({ committedUsd: 1, reservedUsd: 2, reservation: 3, jobCapUsd: 6, accountCapUsd: 7 }),
  );
  assert.isFalse(
    admit({ committedUsd: 1, reservedUsd: 2, reservation: 3, jobCapUsd: 7, accountCapUsd: 5 }),
  );
  assert.isFalse(
    admit({ committedUsd: NaN, reservedUsd: 0, reservation: 0, jobCapUsd: 7, accountCapUsd: 5 }),
  );
  const pricing = { highestRecordedUsdPerSecond: 0.001, outputUsdPerToken: 0.00001 };
  assert.strictEqual(reservationFor("paid", 10, 1000, pricing), 0.02);
  assert.strictEqual(reservationFor("example:free", 10, 1000, pricing), 0);
});
it.effect("limits all free models together with a rolling minute and UTC daily reset", () =>
  Effect.gen(function* () {
    const limiter = yield* FreeModelLimiter;
    yield* Effect.repeat(limiter.acquire, { times: 19 });
    const minute = yield* Effect.flip(limiter.acquire);
    assert.strictEqual(minute.period, "minute");
    yield* TestClock.adjust(60_000);
    yield* limiter.acquire;
    const day = yield* Effect.flip(limiter.acquire);
    assert.strictEqual(day.period, "day");
    yield* TestClock.adjust(86_400_000);
    yield* limiter.acquire;
  }).pipe(Effect.provide(freeModelLimiterLayer(21))),
);
it.effect("preserves benchmark prompt bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = "/home/pedro/tcc/benchmark/src/openRouterEvaluation.ts";
    const source = yield* fs.readFileString(
      (yield* fs.exists(path))
        ? path
        : "apps/server/test/fixtures/openrouter/benchmark-prompt-source.txt",
    );
    const domainPath = "/home/pedro/tcc/benchmark/src/domain.ts";
    const domain = yield* fs.readFileString(
      (yield* fs.exists(domainPath))
        ? domainPath
        : "apps/server/test/fixtures/openrouter/benchmark-classes-source.txt",
    );
    const classLiteral = domain.match(
      /export const targetEventClasses = (\[[\s\S]*?\]) as const/,
    )?.[1];
    const classes = JSON.parse((classLiteral ?? "[]").replace(/,\s*\]/, "]"));
    assert.deepStrictEqual(classes, [...targetEventClasses]);
    const system = source.match(/"You detect soccer highlight events[^\n]+"/)?.[0];
    assert.strictEqual(system === undefined ? "" : JSON.parse(system), systemPrompt);
    const text = source.match(/`Allowed event classes:[\s\S]*?\.join\("\\n"\)/)?.[0];
    assert.isDefined(text);
    const lines = text?.match(/"(?:Use timestamp_seconds|If there)[^\n]+"/g) ?? [];
    assert.strictEqual(
      [
        `Allowed event classes: ${classes.join(", ")}.`,
        ...lines.map((line) => JSON.parse(line)),
      ].join("\n"),
      userPrompt,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("sends strict video JSON and keeps the complete provider body", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = `${dir}/clip.mp4`;
    yield* fs.writeFile(path, new Uint8Array([1, 2, 3]));
    const fullBody = {
      id: "gen-test",
      choices: [],
      usage: { cost: 0, prompt_tokens: 10 },
      provider: "fixture",
    };
    const http = HttpClient.make((request) => {
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.body._tag, "Uint8Array");
      if (request.body._tag === "Uint8Array")
        assert.deepStrictEqual(
          JSON.parse(new TextDecoder().decode(request.body.body)),
          requestBody("test:free", "data:video/mp4;base64,AQID", 100),
        );
      assert.deepStrictEqual(requestBody("test:free", "data:video/mp4;base64,AQID", 100).provider, {
        require_parameters: true,
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(fullBody))),
      );
    });
    const actual = yield* Effect.gen(function* () {
      const provider = yield* OpenRouter;
      return yield* provider.complete({
        model: "test:free",
        promptVersion: "benchmark-v1",
        clipPath: path,
        maxTokens: 100,
      });
    }).pipe(
      Effect.provide(
        openRouterLayer("test").pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(freeModelLimiterLayer()),
        ),
      ),
    );
    assert.deepStrictEqual(actual.body, fullBody);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("times out an unresponsive provider using TestClock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = `${dir}/clip.mp4`;
    yield* fs.writeFile(path, new Uint8Array([1]));
    const started = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const fiber = yield* Effect.gen(function* () {
      const provider = yield* OpenRouter;
      return yield* provider
        .complete({
          model: "test:free",
          promptVersion: "benchmark-v1",
          clipPath: path,
          maxTokens: 100,
        })
        .pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        openRouterLayer("test", 1000).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(freeModelLimiterLayer()),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(1000);
    assert.strictEqual((yield* Fiber.join(fiber)).category, "Timeout");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
