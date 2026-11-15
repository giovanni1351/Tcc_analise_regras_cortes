import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { cvParams, cvProvenance } from "./provenance.ts";
import { stageKey } from "../jobs/keys.ts";

it.effect(
  "CV cache misses when model, either worker source or any inference parameter changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(root + "/workers/cv", { recursive: true });
      yield* fs.makeDirectory(root + "/src/tcc_soccer_highlights", { recursive: true });
      const files = [
        "best.pt",
        "workers/cv/worker.py",
        "src/tcc_soccer_highlights/batch_analysis.py",
      ];
      for (const file of files) yield* fs.writeFileString(root + "/" + file, "original");
      const params = { ...cvParams, ...(yield* cvProvenance(root)) };
      for (const stage of ["scenes", "detections"]) {
        const original = yield* stageKey(stage, "v1", params, []);
        for (const [field, value] of Object.entries(cvParams)) {
          assert.notStrictEqual(
            yield* stageKey(stage, "v1", { ...params, [field]: value + 1 }, []),
            original,
            field,
          );
        }
        for (const file of files) {
          yield* fs.writeFileString(root + "/" + file, "changed");
          const changed = { ...cvParams, ...(yield* cvProvenance(root)) };
          assert.notStrictEqual(yield* stageKey(stage, "v1", changed, []), original, file);
          yield* fs.writeFileString(root + "/" + file, "original");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
