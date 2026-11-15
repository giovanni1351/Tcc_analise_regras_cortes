import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { MediaHash, Probe } from "@tcc/contracts";
import { Process } from "../process.ts";
import { ObjectDetector, SceneDetector } from "../services.ts";
import { cvLayer } from "./index.ts";

const media = {
  path: "/source",
  hash: Schema.decodeSync(MediaHash)("a".repeat(64)),
  probe: Schema.decodeSync(Probe)({ duration: 1, fps: 25, frameCount: 25, size: 1 }),
  sourceStat: { size: 1, mtimeMs: 0 },
};
const Request = Schema.fromJsonString(Schema.Struct({ id: Schema.String, op: Schema.String }));

for (const mode of ["valid", "malformed", "error", "wrong-id", "eof"] as const) {
  it.effect(`worker protocol ${mode}`, () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      let spawns = 0;
      const fake = Layer.succeed(Process, {
        spawn: () =>
          Effect.sync(() => {
            spawns++;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.forEach((bytes: Uint8Array) =>
                Effect.gen(function* () {
                  const request = yield* Schema.decodeEffect(Request)(
                    new TextDecoder().decode(bytes),
                  ).pipe(Effect.orDie);
                  const lines =
                    mode === "malformed"
                      ? ["broken"]
                      : mode === "error"
                        ? [
                            JSON.stringify({
                              id: request.id,
                              kind: "error",
                              device: "cpu",
                              message: "failed",
                            }),
                          ]
                        : mode === "eof"
                          ? []
                          : [
                              JSON.stringify({
                                id: request.id,
                                kind: "progress",
                                device: "cuda",
                                done: 25,
                                total: 25,
                              }),
                              JSON.stringify({
                                id: mode === "wrong-id" ? "wrong" : request.id,
                                kind: "result",
                                device: "cuda",
                                op: request.op,
                                items: [],
                              }),
                            ];
                  for (const line of lines)
                    yield* Queue.offer(output, new TextEncoder().encode(line + "\n"));
                }),
              ),
              stdout: mode === "eof" ? Stream.empty : Stream.fromQueue(output),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
      });
      yield* Effect.gen(function* () {
        assert.strictEqual(spawns, 0);
        const detector = yield* ObjectDetector;
        const progress: number[] = [];
        const result = yield* detector
          .detect(media, 5, (done) =>
            Effect.sync(() => {
              progress.push(done);
            }),
          )
          .pipe(Effect.result);
        assert.strictEqual(result._tag, mode === "valid" ? "Success" : "Failure");
        if (result._tag === "Success") {
          assert.strictEqual(result.success.device, "cuda");
          assert.deepStrictEqual(progress, [25]);
          yield* (yield* SceneDetector).detect(media);
          assert.strictEqual(spawns, 1);
        }
      }).pipe(Effect.provide(cvLayer("/repo").pipe(Layer.provide(fake))));
    }).pipe(Effect.scoped),
  );
}

it.effect("interrupting detection closes the worker resource", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const killed = yield* Deferred.make<void>();
    const fake = Layer.succeed(Process, {
      spawn: () =>
        Effect.acquireRelease(
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.forEach(() => Deferred.succeed(started, undefined)),
              stdout: Stream.never,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
          () => Deferred.succeed(killed, undefined),
        ),
    });
    yield* Effect.gen(function* () {
      const detector = yield* ObjectDetector;
      const fiber = yield* detector.detect(media, 5, () => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(killed);
    }).pipe(Effect.provide(cvLayer("/repo").pipe(Layer.provide(fake))));
  }).pipe(Effect.scoped),
);
