import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter } from "effect/http";
import { Api } from "@tcc/contracts";
import { BudgetService } from "./budget.ts";
import { Repository } from "./jobs/repository.ts";
import { Sources } from "./jobs/sources.ts";
import { Runner } from "./jobs/runner.ts";
import { getBlob } from "./api/blobs.ts";

export const handlersLayer = HttpApiBuilder.group(Api, "highlights", (handlers) =>
  Effect.gen(function* () {
    const budget = yield* BudgetService;
    const repo = yield* Repository;
    const sources = yield* Sources;
    const runner = yield* Runner;
    return handlers
      .handle("registerSource", ({ payload }) => sources.register(payload))
      .handle("getSource", ({ params }) => repo.source(params.id))
      .handle("createJob", ({ payload }) =>
        repo
          .create(payload.sourceId, payload.spec, payload.force)
          .pipe(Effect.tap(() => runner.notify)),
      )
      .handle("listJobs", ({ query }) => repo.list(query.offset, query.limit, query.state))
      .handle("getJob", ({ params }) => repo.job(params.id))
      .handle("cancelJob", ({ params }) => runner.cancel(params.id))
      .handle("resumeJob", ({ params, payload }) =>
        runner.resume(params.id, payload.retryAmbiguous),
      )
      .handle("getResult", ({ params }) => repo.result(params.id))
      .handleRaw("getBlob", ({ params, request }) => getBlob(params.hash, request.headers.range))
      .handle("evaluationContext", ({ params }) => repo.evaluationContext(params.id))
      .handle("modelRate", ({ query }) => repo.modelRate(query.model))
      .handle("budget", () => budget.get);
  }),
);
export const httpLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlersLayer)),
);
