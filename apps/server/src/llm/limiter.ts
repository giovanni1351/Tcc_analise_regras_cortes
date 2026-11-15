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
export const freeModelLimiterLayer = (dailyCap = 50) =>
  Layer.effect(
    FreeModelLimiter,
    Effect.gen(function* () {
      const state = yield* Ref.make<{ day: number; daily: number; recent: number[] }>({
        day: -1,
        daily: 0,
        recent: [],
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
