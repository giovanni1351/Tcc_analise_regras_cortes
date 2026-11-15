import { heldReservationSql } from "./accounting.ts";
import { DateTime, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { ProviderReply, ParsedVerdict } from "../services.ts";
import { ProviderError } from "../services.ts";
import { admit } from "./admission.ts";

export class LedgerError extends Schema.TaggedError<
  LedgerError,
  { readonly brand: unique symbol }
>()("LedgerError", {
  operation: Schema.String,
  resource: Schema.String,
  cause: Schema.Defect(),
}) {}
export interface Reservation {
  readonly id: string;
  readonly verdictKey?: string;
  readonly jobId: string;
  readonly segmentId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly attemptNumber: number;
  readonly reservation: number;
  readonly jobCapUsd: number;
  readonly accountCapUsd: number;
}
export class AttemptLedger extends Context.Service<
  AttemptLedger,
  {
    readonly reserve: (input: Reservation) => Effect.Effect<boolean, LedgerError>;
    readonly markSent: (id: string) => Effect.Effect<void, LedgerError>;
    readonly answer: (
      id: string,
      reply: ProviderReply,
      parsed: ParsedVerdict,
    ) => Effect.Effect<void, LedgerError>;
    readonly fail: (id: string, cause: unknown) => Effect.Effect<void, LedgerError>;
    readonly recoverOnStartup: Effect.Effect<void, LedgerError>;
  }
>()("@tcc/server/llm/ledger/AttemptLedger") {}

export const attemptLedgerLayer = Layer.effect(
  AttemptLedger,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wrap = (operation: string, resource: string) => (cause: unknown) =>
      new LedgerError({ operation, resource, cause });
    const reserve = Effect.fn("AttemptLedger.reserve")(function* (input: Reservation) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const totals = yield* sql<{
              job_id: string;
              committed: number;
              reserved: number;
            }>`SELECT job_id, COALESCE(SUM(cost_usd),0) AS committed, ${sql.literal(heldReservationSql)} AS reserved FROM llm_attempts GROUP BY job_id`;
            const job = totals.find((row) => row.job_id === input.jobId);
            if (
              input.reservation !== 0 &&
              (!admit({
                committedUsd: job?.committed ?? 0,
                reservedUsd: job?.reserved ?? 0,
                reservation: input.reservation,
                jobCapUsd: input.jobCapUsd,
                accountCapUsd: input.jobCapUsd,
              }) ||
                !admit({
                  committedUsd: totals.reduce((n, row) => n + row.committed, 0),
                  reservedUsd: totals.reduce((n, row) => n + row.reserved, 0),
                  reservation: input.reservation,
                  jobCapUsd: input.accountCapUsd,
                  accountCapUsd: input.accountCapUsd,
                }))
            )
              return false;
            yield* sql`INSERT INTO llm_attempts (id,job_id,segment_id,model,prompt_version,attempt_number,state,reserved_usd,created_at,updated_at,verdict_key) VALUES (${input.id},${input.jobId},${input.segmentId},${input.model},${input.promptVersion},${input.attemptNumber},'Reserved',${input.reservation},${now},${now},${input.verdictKey ?? null})`;
            return true;
          }),
        )
        .pipe(Effect.mapError(wrap("reserve", input.id)));
    });
    const markSent = Effect.fn("AttemptLedger.markSent")(
      function* (id: string) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows =
          yield* sql`UPDATE llm_attempts SET state='Sent',updated_at=${now} WHERE id=${id} AND state='Reserved' RETURNING id`;
        if (rows.length !== 1)
          return yield* new LedgerError({
            operation: "markSent",
            resource: id,
            cause: "Attempt is not Reserved",
          });
      },
      Effect.mapError(
        (cause) => new LedgerError({ operation: "markSent", resource: "attempt", cause }),
      ),
    );
    const answer = Effect.fn("AttemptLedger.answer")(
      function* (id: string, reply: ProviderReply, parsed: ParsedVerdict) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const usage =
          typeof reply.body === "object" && reply.body !== null && "usage" in reply.body
            ? reply.body.usage
            : null;
        const rows =
          yield* sql`UPDATE llm_attempts SET state='Answered',cost_usd=${reply.costUsd},http_status=${reply.httpStatus},response_json=${JSON.stringify(reply.body)},verdict_json=${parsed._tag === "Valid" ? JSON.stringify(parsed.verdict) : null},parse_error_json=${parsed._tag === "Invalid" ? JSON.stringify(parsed.reason) : null},usage_json=${JSON.stringify(usage)},generation_id=${reply.generationId},latency_ms=${reply.latencyMs},updated_at=${now} WHERE id=${id} AND state IN ('Sent','Ambiguous') RETURNING id`;
        if (rows.length !== 1)
          return yield* new LedgerError({
            operation: "answer",
            resource: id,
            cause: "Attempt is not Sent or Ambiguous",
          });
      },
      Effect.mapError(
        (cause) => new LedgerError({ operation: "answer", resource: "attempt", cause }),
      ),
    );
    const fail = Effect.fn("AttemptLedger.fail")(
      function* (id: string, cause: unknown) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const notSent = Schema.is(ProviderError)(cause) && cause.sent === false;
        const status = Schema.is(ProviderError)(cause) ? cause.httpStatus : null;
        const refused =
          Schema.is(ProviderError)(cause) &&
          cause.httpStatus !== null &&
          (cause.httpStatus >= 400 || (cause.httpStatus === 200 && cause.category === "Upstream"));
        yield* sql`UPDATE llm_attempts SET state=CASE WHEN state='Sent' AND ${refused || notSent ? 0 : 1}=1 THEN 'Ambiguous' ELSE 'Failed' END,http_status=${status},parse_error_json=${JSON.stringify(cause)},updated_at=${now} WHERE id=${id} AND state IN ('Reserved','Sent')`;
      },
      Effect.mapError(
        (cause) => new LedgerError({ operation: "fail", resource: "attempt", cause }),
      ),
    );
    const recover = Effect.fn("AttemptLedger.recoverOnStartup")(
      function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE llm_attempts SET state='Ambiguous',updated_at=${now} WHERE state='Sent'`;
        yield* sql`UPDATE llm_attempts SET state='Failed',updated_at=${now} WHERE state='Reserved'`;
      },
      Effect.mapError(wrap("recover", "llm_attempts")),
    );
    return { reserve, markSent, answer, fail, recoverOnStartup: recover() };
  }),
);
