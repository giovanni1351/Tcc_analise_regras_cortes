import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { Count, FrameIndex, NonNegative, VideoSeconds } from "@tcc/contracts";
import { Process } from "../process.ts";
import { InferenceError, ObjectDetector, SceneDetector } from "../services.ts";
import type { ProbedMedia } from "../services.ts";

import { cvParams } from "./provenance.ts";

const Device = Schema.Literals(["cuda", "cpu", "coreml"]);
const Scene = Schema.Struct({
  sceneId: Count,
  startFrame: FrameIndex,
  endFrame: FrameIndex,
  startSec: VideoSeconds,
  durationSec: NonNegative,
});
const Sample = Schema.Struct({
  frameIndex: FrameIndex,
  timeSec: VideoSeconds,
  counts: Schema.Struct({ player: Count, goalkeeper: Count, referee: Count, ball: Count }),
});
const common = { id: Schema.String, device: Device };
const Message = Schema.Union([
  Schema.Struct({ ...common, kind: Schema.Literal("progress"), done: Count, total: Count }),
  Schema.Struct({ ...common, kind: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("result"),
    op: Schema.Literal("scenes"),
    items: Schema.Array(Scene),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("result"),
    op: Schema.Literal("detections"),
    items: Schema.Array(Sample),
  }),
]);
const MessageJson = Schema.fromJsonString(Message);

class Worker extends Context.Service<
  Worker,
  {
    readonly request: (
      op: "scenes" | "detections",
      media: ProbedMedia,
      stride: number,
      progress: (done: number, total: number) => Effect.Effect<void>,
    ) => Effect.Effect<Extract<typeof Message.Type, { kind: "result" }>, InferenceError>;
  }
>()("@tcc/server/cv/Worker") {}

export const cvWorkerLayer = (repoRoot: string) =>
  Layer.effect(
    Worker,
    Effect.gen(function* () {
      const process = yield* Process;
      const owner = yield* Effect.scope;
      const permit = yield* Semaphore.make(1);
      const start = Effect.fn("CV.start")(function* () {
        const scope = yield* Scope.fork(owner);
        const outgoing = yield* Queue.unbounded<Uint8Array>();
        const incoming = yield* Queue.unbounded<string, Cause.Done>();
        const child = yield* process
          .spawn("env", [
            "UV_HTTP_TIMEOUT=600",
            "uv",
            "run",
            "--project",
            repoRoot,
            "--no-sync",
            "python",
            "-u",
            `${repoRoot}/workers/cv/worker.py`,
          ])
          .pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
        yield* Stream.fromQueue(outgoing).pipe(
          Stream.run(child.stdin),
          Effect.onExit(() => Queue.end(incoming)),
          Effect.forkIn(scope),
        );
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Queue.offer(incoming, line)),
          Effect.onExit(() => Queue.end(incoming)),
          Effect.forkIn(scope),
        );
        let stderr = "";
        yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderr = (stderr + chunk).slice(-8192);
            }),
          ),
          Effect.forkIn(scope),
        );
        return { scope, outgoing, incoming, stderr: () => stderr };
      });
      let worker: Effect.Success<ReturnType<typeof start>> | undefined;
      let serial = 0;
      const request = Effect.fn("CV.request")(function* (
        op: "scenes" | "detections",
        media: ProbedMedia,
        stride: number,
        progress: (done: number, total: number) => Effect.Effect<void>,
      ) {
        const model = op === "scenes" ? "transnetv2" : "yolo";
        return yield* permit
          .withPermits(1)(
            Effect.gen(function* () {
              worker ??= yield* start();
              const active = worker;
              const id = String(++serial);
              return yield* Effect.gen(function* () {
                yield* Queue.offer(
                  active.outgoing,
                  new TextEncoder().encode(
                    JSON.stringify({ ...cvParams, id, op, path: media.path, stride }) + "\n",
                  ),
                );
                while (true) {
                  const line = yield* Queue.take(active.incoming).pipe(
                    Effect.mapError(
                      (cause) =>
                        new InferenceError({
                          model,
                          path: media.path,
                          cause: { exit: cause, stderr: active.stderr() },
                        }),
                    ),
                  );
                  const message = yield* Schema.decodeEffect(MessageJson)(line);
                  if (message.id !== id)
                    return yield* new InferenceError({
                      model,
                      path: media.path,
                      cause: "Mismatched worker request id",
                    });
                  if (message.kind === "error")
                    return yield* new InferenceError({
                      model,
                      path: media.path,
                      cause: message.message,
                    });
                  if (message.kind === "progress") {
                    yield* progress(message.done, message.total);
                    continue;
                  }
                  if (message.op !== op)
                    return yield* new InferenceError({
                      model,
                      path: media.path,
                      cause: "Mismatched worker operation",
                    });
                  return message;
                }
              }).pipe(
                Effect.onError(() =>
                  Effect.gen(function* () {
                    worker = undefined;
                    yield* Scope.close(active.scope, Exit.void);
                  }),
                ),
              );
            }),
          )
          .pipe(Effect.mapError((cause) => new InferenceError({ model, path: media.path, cause })));
      });
      return { request };
    }),
  );

export const sceneDetectorLayer = Layer.effect(
  SceneDetector,
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      detect: Effect.fn("SceneDetector.detect")(function* (media: ProbedMedia) {
        const result = yield* worker.request("scenes", media, 5, () => Effect.void);
        if (result.op !== "scenes")
          return yield* new InferenceError({
            model: "transnetv2",
            path: media.path,
            cause: "Invalid result",
          });
        return { device: result.device, items: result.items };
      }),
    };
  }),
);
export const objectDetectorLayer = Layer.effect(
  ObjectDetector,
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      detect: Effect.fn("ObjectDetector.detect")(function* (
        media: ProbedMedia,
        stride: number,
        progress: (done: number, total: number) => Effect.Effect<void>,
      ) {
        const result = yield* worker.request("detections", media, stride, progress);
        if (result.op !== "detections")
          return yield* new InferenceError({
            model: "yolo",
            path: media.path,
            cause: "Invalid result",
          });
        return { device: result.device, items: result.items };
      }),
    };
  }),
);
export const cvLayer = (repoRoot: string) =>
  Layer.merge(sceneDetectorLayer, objectDetectorLayer).pipe(Layer.provide(cvWorkerLayer(repoRoot)));
