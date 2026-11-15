import { SqlClient } from "effect/sql";
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";

export class FreeLimit extends Schema.TaggedError<FreeLimit, { readonly brand: unique symbol }>()(
  "FreeLimit",
  {
    retryAfterMs: Schema.Number,
    period: Schema.Literals(["minute", "day"]),
  },
) {}
export class FreeModelLimiter extends Context.Service<
  FreeModelLimiter,
  {
    readonly acquire: Effect.Effect<void, FreeLimit>;
  }
>()("@tcc/server/llm/limiter/FreeModelLimiter") {}
export const freeModelLimiterLayer = (dailyCap = 50, timestamps: ReadonlyArray<number> = []) =>
  Layer.effect(
    FreeModelLimiter,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const day = Math.floor(now / 86_400_000);
      const state = yield* Ref.make<{ day: number; daily: number; recent: number[] }>({
        day,
        daily: timestamps.filter((time) => Math.floor(time / 86_400_000) === day).length,
        recent: timestamps.filter((time) => time > now - 60_000).sort((a, b) => a - b),
      });
      const acquire = Effect.fn("FreeModelLimiter.acquire")(function* () {
        const now = yield* Clock.currentTimeMillis;
        const day = Math.floor(now / 86_400_000);
        const denied = yield* Ref.modify(state, (previous) => {
          const daily = previous.day === day ? previous.daily : 0;
          const recent = previous.recent.filter((time) => time > now - 60_000);
          const first = recent[0];
          if (daily >= dailyCap)
            return [
              new FreeLimit({ period: "day", retryAfterMs: (day + 1) * 86_400_000 - now }),
              previous,
            ];
          if (recent.length >= 20 && first !== undefined)
            return [
              new FreeLimit({ period: "minute", retryAfterMs: first + 60_000 - now }),
              previous,
            ];
          return [null, { day, daily: daily + 1, recent: [...recent, now] }];
        });
        if (denied !== null) return yield* denied;
      });
      return { acquire: acquire() };
    }),
  );

export const persistedFreeModelLimiterLayer = (dailyCap: number) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        created_at: string;
      }>`SELECT created_at FROM llm_attempts WHERE model LIKE '%:free' AND (state IN ('Sent','Answered','Ambiguous') OR (state='Failed' AND http_status IS NOT NULL))`;
      return freeModelLimiterLayer(
        dailyCap,
        rows.map((row) => Date.parse(row.created_at)),
      );
    }),
  );
