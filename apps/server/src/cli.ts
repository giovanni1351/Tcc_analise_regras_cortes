import * as Http from "node:http"; // NodeHttpServer requires a native server factory.
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Api, NonNegative } from "@tcc/contracts";
import { databaseLayer } from "./database.ts";
import { budgetLayer } from "./budget.ts";
import { acquireDataDirectoryLock } from "./lock.ts";
import { httpLayer } from "./http.ts";

export class CliError extends Schema.TaggedError<CliError, { readonly brand: unique symbol }>()(
  "CliError",
  { message: Schema.String },
) {}
const main = Effect.gen(function* () {
  const port = yield* Config.Int("TCC_PORT").pipe(Config.withDefault(3000));
  if (port < 1 || port > 65535)
    return yield* new CliError({ message: "TCC_PORT must be between 1 and 65535" });
  const command = process.argv[2];
  if (command === "budget") {
    const client = yield* HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });
    const result = yield* client.highlights.budget();
    yield* Console.log(result);
    return;
  }
  if (command !== "serve")
    return yield* new CliError({ message: "Usage: pnpm start <serve|budget>" });
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
  const services = budgetLayer(limit).pipe(
    Layer.provide(databaseLayer(path.join(dataDir, "highlights.sqlite"))),
  );
  return yield* Layer.launch(
    httpLayer.pipe(
      Layer.provide(services),
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
