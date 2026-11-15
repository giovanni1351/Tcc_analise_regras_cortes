import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter } from "effect/http";
import { Api, NotImplemented } from "@tcc/contracts";
import { BudgetService } from "./budget.ts";

const unimplemented = (operation: string) => Effect.fail(new NotImplemented({ operation }));
export const handlersLayer = HttpApiBuilder.group(Api, "highlights", (handlers) =>
  Effect.gen(function* () {
    const budget = yield* BudgetService;
    return handlers
      .handle("registerSource", () => unimplemented("registerSource"))
      .handle("getSource", () => unimplemented("getSource"))
      .handle("createJob", () => unimplemented("createJob"))
      .handle("listJobs", () => unimplemented("listJobs"))
      .handle("getJob", () => unimplemented("getJob"))
      .handle("cancelJob", () => unimplemented("cancelJob"))
      .handle("resumeJob", () => unimplemented("resumeJob"))
      .handle("getResult", () => unimplemented("getResult"))
      .handle("getBlob", () => unimplemented("getBlob"))
      .handle("budget", () => budget.get);
  }),
);
export const httpLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlersLayer)),
);
