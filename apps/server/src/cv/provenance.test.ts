import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { cvStageParams, cvProvenance } from "./provenance.ts";
import { stageKey } from "../jobs/keys.ts";
import { processLayer } from "../process.ts";

it.effect("TransNet weights invalidate scenes and downstream caches but preserve detections", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(root + "/workers/cv", { recursive: true });
    yield* fs.makeDirectory(root + "/src/tcc_soccer_highlights", { recursive: true });
    for (const file of [
      "best.pt",
      "transnet.pth",
      "workers/cv/worker.py",
      "src/tcc_soccer_highlights/batch_analysis.py",
    ])
      yield* fs.writeFileString(root + "/" + file, "original");
    const keys = Effect.gen(function* () {
      const provenance = yield* cvProvenance(root, root + "/transnet.pth");
      const scene = yield* stageKey("scenes", "v1", cvStageParams("scenes", provenance), []);
      const detection = yield* stageKey(
        "detections",
        "v1",
        cvStageParams("detections", provenance),
        [],
      );
      const result = [scene, detection];
      let inputs = [scene, detection];
      for (const stage of ["windows", "segments", "verdicts", "highlights"]) {
        const key = yield* stageKey(stage, "v1", {}, inputs);
        result.push(key);
        inputs = [key];
      }
      return result;
    });
    const original = yield* keys;
    yield* fs.writeFileString(root + "/transnet.pth", "changed");
    const changed = yield* keys;
    original.forEach((key, i) =>
      i === 1 ? assert.strictEqual(changed[i], key) : assert.notStrictEqual(changed[i], key),
    );
    yield* fs.writeFileString(root + "/transnet.pth", "original");
    yield* fs.writeFileString(root + "/best.pt", "changed");
    const yolo = yield* keys;
    assert.strictEqual(yolo[0], original[0]);
    assert.notStrictEqual(yolo[1], original[1]);
  }).pipe(Effect.scoped, Effect.provide(processLayer), Effect.provide(NodeServices.layer)),
);
