import { parseArgs } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { JobId } from "@tcc/contracts";
import { makeEvaluationClient, scoreJob } from "./score-job.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const { values } = yield* Effect.try(() =>
      parseArgs({
        options: {
          job: { type: "string" },
          port: { type: "string", default: "3000" },
          "include-not-shown": { type: "boolean", default: false },
        },
      }),
    );
    const id = yield* Schema.decodeUnknownEffect(JobId)(values.job);
    const client = yield* makeEvaluationClient(Number(values.port));
    yield* Console.log(
      JSON.stringify(yield* scoreJob(client.highlights, id, values["include-not-shown"]), null, 2),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
