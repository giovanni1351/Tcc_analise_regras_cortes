import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { MediaHash, Probe } from "@tcc/contracts";
import { Process, processLayer } from "../process.ts";
import { ObjectDetector } from "../services.ts";
import { cvLayer } from "./index.ts";

it.live(
  "interrupting a real detect kills the worker process group",
  () =>
    Effect.gen(function* () {
      const process = yield* Process;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const pidFile = `${dir}/pids`;
      const script = `${dir}/worker.py`;
      yield* fs.writeFileString(
        script,
        `import sys, subprocess, os, json, signal\nchild = subprocess.Popen(["sleep", "300"])\nsignal.signal(signal.SIGTERM, lambda *_: (child.wait(), sys.exit(0)))\nopen(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()) + " " + str(child.pid))\nfor line in sys.stdin:\n r = json.loads(line)\n print(json.dumps(dict(id=r["id"],kind="progress",device="cpu",done=0,total=1)), flush=True)\n signal.pause()\n`,
      );
      const started = yield* Deferred.make<void>();
      const layer = cvLayer("/unused").pipe(
        Layer.provide(
          Layer.succeed(Process, { spawn: () => process.spawn("python", ["-u", script]) }),
        ),
      );
      yield* Effect.gen(function* () {
        const detector = yield* ObjectDetector;
        const hash = yield* Schema.decodeEffect(MediaHash)("a".repeat(64));
        const probe = yield* Schema.decodeEffect(Probe)({
          duration: 1,
          fps: 25,
          size: 1,
          frameCount: 25,
        });
        const fiber = yield* detector
          .detect({ path: "/unused", hash, probe, sourceStat: { size: 1, mtimeMs: 0 } }, 5, () =>
            Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const pids = (yield* fs.readFileString(pidFile)).split(" ");
        yield* Fiber.interrupt(fiber);
        for (const pid of pids)
          assert.strictEqual(
            yield* fs.exists(`/proc/${pid}`),
            false,
            `PID ${pid} survived interruption`,
          );
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.provide(processLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  { timeout: 15000 },
);
