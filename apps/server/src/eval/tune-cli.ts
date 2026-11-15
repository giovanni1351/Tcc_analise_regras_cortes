import { parseArgs } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { EvaluationError, makeEvaluationClient } from "./score-job.ts";
import { makeTunePlan, runTune } from "./tune.ts";
import { studySplit } from "./split.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const { values } = yield* Effect.try(() =>
      parseArgs({
        options: {
          split: { type: "string", default: "train" },
          halves: { type: "string", default: "5" },
          model: { type: "string" },
          grid: { type: "string", default: "40/5,30/5,20/4" },
          port: { type: "string", default: "3000" },
          "study-dir": { type: "string", default: ".scratch/study" },
          "max-usd": { type: "string", default: "0" },
          "usd-per-call": { type: "string" },
          "dry-run": { type: "boolean", default: false },
          "print-split": { type: "boolean", default: false },
          "include-not-shown": { type: "boolean", default: false },
          out: { type: "string", default: "tuning-report.json" },
        },
      }),
    );
    if (values["print-split"]) return yield* Console.log(JSON.stringify(studySplit, null, 2));
    const split = values.split;
    if (split !== "train" && split !== "test")
      return yield* new EvaluationError({
        operation: "arguments",
        resource: "--split",
        cause: "Expected train or test",
      });
    const model = values.model ?? "nvidia/nemotron-3.5-super-vl:free";
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return yield* new EvaluationError({
        operation: "arguments",
        resource: "--port",
        cause: "Invalid port",
      });
    const client = (yield* makeEvaluationClient(port)).highlights;
    const usdPerSecond =
      model.endsWith(":free") || values["usd-per-call"] !== undefined
        ? null
        : (yield* client.modelRate({ query: { model } })).usdPerSecond;
    const plan = yield* makeTunePlan({
      split,
      halves: Number(values.halves),
      model,
      grid: values.grid,
      maxUsd: Number(values["max-usd"]),
      usdPerSecond,
      studyDir: values["study-dir"],
      ...(values["usd-per-call"] === undefined
        ? {}
        : { usdPerCall: Number(values["usd-per-call"]) }),
    });
    yield* Console.log(JSON.stringify(plan, null, 2));
    const fs = yield* FileSystem.FileSystem;
    const save = (report: unknown) =>
      fs
        .writeFileString(values.out, JSON.stringify(report, null, 2) + "\n")
        .pipe(
          Effect.mapError(
            (cause) => new EvaluationError({ operation: "report", resource: values.out, cause }),
          ),
        );
    const report = yield* runTune(
      client,
      plan,
      { dryRun: values["dry-run"], includeNotShown: values["include-not-shown"] },
      save,
    );
    if (!values["dry-run"]) yield* save(report);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
