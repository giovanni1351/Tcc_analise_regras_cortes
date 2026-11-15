import { Effect, FileSystem, Layer } from "effect";
import { blobStoreLayer } from "../media/index.ts";
import { databaseLayer } from "../database.ts";
import { budgetLayer } from "../budget.ts";
import { repositoryLayer } from "./repository.ts";
import { sourcesLayer } from "./sources.ts";
import { StageLogic, LlmStep, stageRunsLayer } from "./stages.ts";
import { runnerLayer } from "./runner.ts";
import { devProbeLayer, devStageLogic, devLlmStep } from "./dev.ts";

export const fixtureServices = (
  directory: string,
  filename = ":memory:",
  logic?: StageLogic["Service"],
  llm?: LlmStep["Service"],
) => {
  const database = databaseLayer(filename);
  const repo = repositoryLayer.pipe(Layer.provideMerge(database));
  const media = Layer.mergeAll(
    blobStoreLayer(directory),
    devProbeLayer,
    Layer.succeed(StageLogic, logic ?? devStageLogic),
    Layer.succeed(LlmStep, llm ?? devLlmStep),
  );
  const sources = sourcesLayer().pipe(Layer.provideMerge(repo), Layer.provideMerge(media));
  const runs = stageRunsLayer.pipe(Layer.provideMerge(sources));
  return Layer.mergeAll(
    runnerLayer.pipe(Layer.provideMerge(runs)),
    budgetLayer(0).pipe(Layer.provide(database)),
  );
};
export const testServices = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    return fixtureServices(directory);
  }),
);
