import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Budget, PersistenceError } from "@tcc/contracts";

export class BudgetService extends Context.Service<
  BudgetService,
  { readonly get: Effect.Effect<Budget, PersistenceError> }
>()("@tcc/server/budget/BudgetService") {}
export const budgetLayer = (limitUsd: number) =>
  Layer.effect(
    BudgetService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const get = Effect.fn("Budget.get")(
        function* () {
          const rows = yield* sql`SELECT
   COALESCE(SUM(cost_usd),0) AS committedUsd,
   COALESCE(SUM(CASE WHEN cost_usd IS NULL AND state IN ('Reserved','Sent','Ambiguous','Answered') THEN reserved_usd ELSE 0 END),0) AS reservedUsd,
   COALESCE(SUM(CASE WHEN cost_usd IS NULL AND state = 'Ambiguous' THEN reserved_usd ELSE 0 END),0) AS ambiguousUsd
   FROM llm_attempts`;
          return yield* Schema.decodeUnknownEffect(Budget)({ ...rows[0], limitUsd });
        },
        Effect.mapError(
          (cause) => new PersistenceError({ operation: "budget", message: String(cause) }),
        ),
      );
      return { get: get() };
    }),
  );
