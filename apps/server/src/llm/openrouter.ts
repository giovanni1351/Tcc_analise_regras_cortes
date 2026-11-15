import { Clock, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { OpenRouter, ProviderError } from "../services.ts";
import type { ProviderRequest } from "../services.ts";
import { promptVersion, requestBody } from "./prompt.ts";
import { Envelope } from "./verdict.ts";
import { FreeModelLimiter } from "./limiter.ts";

const ErrorBody = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Unknown),
    }),
  ),
});
function decodeBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
export function classifyError(
  status: number,
  body: unknown,
  retryAfter: string | undefined,
  nowMs: number,
): ProviderError {
  const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
  const detail = decoded._tag === "Some" ? decoded.value.error : undefined;
  const metadata = JSON.stringify(detail?.metadata ?? {});
  const message = detail?.message ?? `OpenRouter HTTP ${status}`;
  const evidence = `${metadata} ${message}`;
  const category =
    status === 429
      ? "RateLimited"
      : status === 402
        ? /in.?flight|concurrent|outstanding/i.test(evidence)
          ? "InFlightBudget"
          : "CreditExhausted"
        : status === 403 && /moderation|flagged_input|reasons/i.test(evidence)
          ? "Moderation"
          : status === 401 || status === 403
            ? "Unauthorized"
            : "Upstream";
  const numeric = retryAfter === undefined ? NaN : Number(retryAfter);
  const delay =
    retryAfter === undefined
      ? NaN
      : Number.isFinite(numeric)
        ? numeric * 1000
        : Date.parse(retryAfter) - nowMs;
  return new ProviderError({
    category,
    httpStatus: status,
    retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : null,
    message,
    responseBody: body,
  });
}
export const isRetryable = (error: ProviderError) =>
  error.category === "RateLimited" ||
  error.category === "InFlightBudget" ||
  error.category === "Network" ||
  error.category === "Timeout" ||
  (error.category === "Upstream" &&
    (error.httpStatus === 200 ||
      error.httpStatus === 408 ||
      error.httpStatus === 425 ||
      (error.httpStatus !== null && error.httpStatus >= 500)));

export const openRouterLayer = (apiKey: string, timeoutMs = 120_000) =>
  Layer.effect(
    OpenRouter,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      const limiter = yield* FreeModelLimiter;
      const complete = Effect.fn("OpenRouter.complete")(
        function* (request: ProviderRequest) {
          if (request.promptVersion !== promptVersion)
            return yield* new ProviderError({
              category: "Network",
              httpStatus: null,
              retryAfterMs: null,
              message: "Unknown prompt version",
              sent: false,
            });
          if (request.model.endsWith(":free"))
            yield* limiter.acquire.pipe(
              Effect.mapError(
                (limit) =>
                  new ProviderError({
                    category: "RateLimited",
                    httpStatus: null,
                    retryAfterMs: limit.retryAfterMs,
                    message: `Free model ${limit.period} limit`,
                    sent: false,
                  }),
              ),
            );
          const start = yield* Clock.currentTimeMillis;
          const bytes = yield* fs.readFile(request.clipPath).pipe(
            Effect.mapError(
              () =>
                new ProviderError({
                  category: "Network",
                  httpStatus: null,
                  retryAfterMs: null,
                  message: "Cannot read clip",
                  sent: false,
                }),
            ),
          );
          const response = yield* http
            .execute(
              HttpClientRequest.post("https://openrouter.ai/api/v1/chat/completions").pipe(
                HttpClientRequest.setHeaders({ authorization: `Bearer ${apiKey}` }),
                HttpClientRequest.bodyJsonUnsafe(
                  requestBody(
                    request.model,
                    `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}`,
                    request.maxTokens,
                  ),
                ),
              ),
            )
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderError({
                    category: "Network",
                    httpStatus: null,
                    retryAfterMs: null,
                    message: "OpenRouter transport failed",
                  }),
              ),
            );
          const text = yield* response.text.pipe(
            Effect.mapError(
              () =>
                new ProviderError({
                  category: "Upstream",
                  httpStatus: response.status,
                  retryAfterMs: null,
                  message: "Cannot read provider response",
                }),
            ),
          );
          const body = decodeBody(text);
          const now = yield* Clock.currentTimeMillis;
          if (response.status < 200 || response.status >= 300)
            return yield* classifyError(
              response.status,
              body,
              response.headers["retry-after"],
              now,
            );
          const failure = Schema.decodeUnknownOption(
            Schema.Struct({
              error: Schema.optionalKey(Schema.Unknown),
              choices: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    finish_reason: Schema.optionalKey(Schema.String),
                  }),
                ),
              ),
            }),
          )(body);
          if (
            failure._tag === "Some" &&
            ("error" in failure.value ||
              failure.value.choices?.some((choice) => choice.finish_reason === "error"))
          )
            return yield* classifyError(response.status, body, undefined, now);
          const decoded = Schema.decodeUnknownOption(Envelope)(body);
          const envelope = decoded._tag === "Some" ? decoded.value : undefined;
          return {
            httpStatus: response.status,
            body,
            generationId: envelope?.id ?? null,
            costUsd: envelope?.usage?.cost ?? null,
            latencyMs: now - start,
          };
        },
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new ProviderError({
                category: "Timeout",
                httpStatus: null,
                retryAfterMs: null,
                message: "OpenRouter timed out",
              }),
            ),
        }),
      );
      return { complete };
    }),
  );
