import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { MediaHash, Probe } from "@tcc/contracts";
import { MediaError, MediaProbe } from "../services.ts";
import { emptyCoverage } from "./repository.ts";
import { LlmStep, StageLogic } from "./stages.ts";

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
          const stat = yield* fs.stat(path);
          return {
            path,
            hash,
            probe,
            sourceStat: {
              size: Number(stat.size),
              mtimeMs: Option.getOrNull(stat.mtime)?.getTime() ?? 0,
            },
          };
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
        ? { llm: job.spec.llm, clips: job.spec.clips }
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
