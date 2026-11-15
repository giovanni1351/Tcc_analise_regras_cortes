import * as Http from "node:http"; // NodeHttpServer requires a native server factory.
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Api, NonNegative, JobId, SourceRef } from "@tcc/contracts";
import { databaseLayer } from "./database.ts";
import { budgetLayer } from "./budget.ts";
import { acquireDataDirectoryLock } from "./lock.ts";
import { httpLayer } from "./http.ts";
import { repositoryLayer } from "./jobs/repository.ts";
import { sourcesLayer } from "./jobs/sources.ts";
import { Runner, runnerLayer } from "./jobs/runner.ts";
import { stageRunsLayer } from "./jobs/stages.ts";
import { devMediaLayer, devProbeLayer, devStagesLayer } from "./jobs/dev.ts";
import { blobStoreLayer, mediaProbeLayer, clipEncoderLayer } from "./media/index.ts";
import { cvLayer } from "./cv/index.ts";
import { processLayer } from "./process.ts";
import { pipelineLayer } from "./jobs/pipeline.ts";
import { mergeOverlaps, toVideoSeconds, pipelineFunctions } from "./jobs/functions.ts";
import { makeHighlightStage } from "./jobs/highlights.ts";
import { llmStepLayer } from "./jobs/llm.ts";
import { AttemptLedger, attemptLedgerLayer } from "./llm/ledger.ts";
import { openRouterLayer } from "./llm/openrouter.ts";
import { persistedFreeModelLimiterLayer } from "./llm/limiter.ts";
import { defaultSpec } from "./jobs/repository.ts";

export class CliError extends Schema.TaggedError<CliError, { readonly brand: unique symbol }>()(
  "CliError",
  { message: Schema.String },
) {}
const main = Effect.gen(function* () {
  const port = yield* Config.Int("TCC_PORT").pipe(Config.withDefault(3000));
  if (port < 1 || port > 65535)
    return yield* new CliError({ message: "TCC_PORT must be between 1 and 65535" });
  const command = process.argv[2];
  if (command === "budget" || command === "jobs" || command === "result" || command === "analyze") {
    const client = yield* HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });
    const result = yield* Effect.gen(function* () {
      if (command === "budget") return yield* client.highlights.budget();
      if (command === "jobs") return yield* client.highlights.listJobs({ query: {} });
      const argument = process.argv[3];
      if (!argument) return yield* new CliError({ message: `${command} requires an argument` });
      if (command === "result")
        return yield* client.highlights.getResult({
          params: { id: yield* Schema.decodeEffect(JobId)(argument) },
        });
      const parts = argument.slice("soccernet:".length).split("/");
      const ref = yield* Schema.decodeUnknownEffect(SourceRef)(
        argument.startsWith("soccernet:")
          ? {
              _tag: "SoccerNetHalf",
              league: parts[0],
              season: parts[1],
              game: parts[2],
              half: Number(parts[3]),
              resolution: parts[4],
            }
          : { _tag: "LocalFile", path: argument },
      );
      const source = yield* client.highlights.registerSource({ payload: ref });
      const requestedModel = process.argv.slice(4).find((argument) => argument !== "--force");
      const model =
        requestedModel ??
        (yield* Config.String("TCC_MODEL").pipe(
          Config.withDefault("nvidia/nemotron-3.5-super-vl:free"),
        ));
      if (!model.endsWith(":free") && !requestedModel)
        return yield* new CliError({
          message: "Paid models must be explicitly passed as the model argument",
        });
      return yield* client.highlights.createJob({
        payload: {
          sourceId: source.id,
          force: process.argv.includes("--force"),
          spec: { ...defaultSpec, llm: { model, promptVersion: "benchmark-v1", maxCostUsd: 0.1 } },
        },
      });
    });
    yield* Console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command !== "serve")
    return yield* new CliError({ message: "Usage: pnpm start <serve|analyze|jobs|result|budget>" });
  const path = yield* Path.Path;
  const override = yield* Config.option(Config.String("TCC_DATA_DIR"));
  const xdg = yield* Config.option(Config.String("XDG_DATA_HOME"));
  const home = yield* Config.String("HOME");
  const dataDir = Option.getOrElse(override, () =>
    path.join(
      Option.getOrElse(xdg, () => path.join(home, ".local", "share")),
      "tcc-highlights",
    ),
  );
  const limit = yield* Config.Number("OPENROUTER_BUDGET_USD").pipe(Config.withDefault(0));
  yield* Schema.decodeEffect(NonNegative)(limit);
  yield* acquireDataDirectoryLock(dataDir);
  const dev = yield* Config.Boolean("TCC_DEV_FAKE_STAGES").pipe(Config.withDefault(false));
  const root = yield* Config.String("TCC_SOCCERNET_ROOT").pipe(
    Config.withDefault("/home/pedro/tcc/benchmark/downloads"),
  );
  const database = databaseLayer(path.join(dataDir, "highlights.sqlite"));
  const repo = repositoryLayer.pipe(Layer.provideMerge(database));
  const apiKey = dev ? "" : yield* Config.String("OPENROUTER_API_KEY");
  const realMedia = Layer.mergeAll(
    mediaProbeLayer,
    blobStoreLayer(dataDir),
    cvLayer(process.cwd()),
  ).pipe(Layer.provideMerge(processLayer));
  const encoders = clipEncoderLayer.pipe(Layer.provideMerge(realMedia));
  const limiter = Layer.unwrap(
    Effect.gen(function* () {
      const dailyCap = yield* Config.Int("OPENROUTER_FREE_DAILY_CAP").pipe(Config.withDefault(50));
      return persistedFreeModelLimiterLayer(dailyCap);
    }),
  ).pipe(Layer.provide(database));
  const llm = llmStepLayer(limit).pipe(
    Layer.provideMerge(openRouterLayer(apiKey).pipe(Layer.provide(limiter))),
    Layer.provideMerge(attemptLedgerLayer.pipe(Layer.provideMerge(database))),
    Layer.provideMerge(encoders),
  );
  const logic = Layer.unwrap(
    Effect.gen(function* () {
      const highlights = yield* makeHighlightStage(mergeOverlaps, toVideoSeconds);
      return pipelineLayer({ ...pipelineFunctions, highlights });
    }),
  ).pipe(Layer.provideMerge(repo), Layer.provideMerge(encoders));
  const media = dev
    ? Layer.mergeAll(devMediaLayer(dataDir), devProbeLayer, devStagesLayer)
    : Layer.mergeAll(logic, llm);
  const sources = sourcesLayer(root).pipe(Layer.provideMerge(repo), Layer.provideMerge(media));
  const runs = stageRunsLayer.pipe(Layer.provideMerge(sources));
  const runner = runnerLayer.pipe(Layer.provideMerge(runs));
  const services = Layer.mergeAll(runner, budgetLayer(limit).pipe(Layer.provide(database)));
  const running = Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* Runner;
      if (!dev)
        yield* AttemptLedger.use((ledger) => ledger.recoverOnStartup).pipe(
          Effect.provide(attemptLedgerLayer.pipe(Layer.provide(database))),
        );
      yield* service.start;
    }),
  ).pipe(Layer.provideMerge(services));
  return yield* Layer.launch(
    httpLayer.pipe(
      Layer.provide(running),
      Layer.provide(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port })),
    ),
  );
});
NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
