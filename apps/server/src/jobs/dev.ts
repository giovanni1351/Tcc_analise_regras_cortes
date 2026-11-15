import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { MediaHash, Probe } from "@tcc/contracts";
import { BlobStore, MediaError, MediaProbe } from "../services.ts";
import { emptyCoverage, newId } from "./repository.ts";
import { LlmStep, StageLogic } from "./stages.ts";

export const devMediaLayer = (dataDir: string) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(dataDir, "blobs", "sha256");
      const blobPath = Effect.fn("DevBlob.path")(
        function* (hash: MediaHash) {
          const dir = path.join(root, hash.slice(0, 2));
          const files = yield* fs.readDirectory(dir);
          const name = files.find((file) => file.startsWith(`${hash}.`));
          if (!name)
            return yield* new MediaError({ operation: "path", path: hash, cause: "Missing blob" });
          return path.join(dir, name);
        },
        Effect.mapError((cause) => new MediaError({ operation: "path", path: root, cause })),
      );
      return {
        tempPath: Effect.fn("DevBlob.temp")(
          function* (ext: string) {
            const dir = yield* fs.makeTempDirectoryScoped();
            return path.join(dir, `${yield* newId}.${ext}`);
          },
          Effect.mapError((cause) => new MediaError({ operation: "temp", path: root, cause })),
        ),
        publish: Effect.fn("DevBlob.publish")(
          function* (temp: string, ext: string) {
            const bytes = yield* fs.readFile(temp);
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
            );
            const hash = yield* Schema.decodeEffect(MediaHash)(
              Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
            );
            const dir = path.join(root, hash.slice(0, 2));
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.copyFile(temp, path.join(dir, `${hash}.${ext}`));
            return hash;
          },
          Effect.mapError((cause) => new MediaError({ operation: "publish", path: root, cause })),
        ),
        path: blobPath,
      };
    }),
  );
export const devProbeLayer = Layer.effect(
  MediaProbe,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      probe: Effect.fn("DevProbe.probe")(
        function* (path: string) {
          const bytes = yield* fs.readFile(path);
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
          );
          const hash = yield* Schema.decodeEffect(MediaHash)(
            Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
          );
          const probe = yield* Schema.decodeEffect(Probe)({
            duration: 1,
            fps: 1,
            frameCount: 1,
            size: bytes.length,
          });
          return { path, hash, probe };
        },
        Effect.mapError((cause) => new MediaError({ operation: "probe", path: "dev", cause })),
      ),
    };
  }),
);
const emptyOutput = {
  artifact: [],
  device: null,
  coverage: emptyCoverage,
  writeRows: () => Effect.void,
};
export const devStageLogic = {
  version: () => "dev-fake-v1",
  params: (stage, job) =>
    stage === "windows"
      ? job.spec.rule
      : stage === "verdicts" || stage === "highlights"
        ? { jobId: job.id, spec: job.spec }
        : {},
  run: Effect.fn("DevStages.run")(() => Effect.succeed(emptyOutput)),
} satisfies StageLogic["Service"];
export const devLlmStep = {
  run: Effect.fn("DevLlm.run")(() => Effect.succeed(emptyOutput)),
} satisfies LlmStep["Service"];
export const devStagesLayer = Layer.mergeAll(
  Layer.succeed(StageLogic, devStageLogic),
  Layer.succeed(LlmStep, devLlmStep),
);
