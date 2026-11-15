import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  Budget,
  Count,
  Job,
  JobId,
  JobResult,
  JobSpec,
  MediaHash,
  Source,
  SourceId,
  SourceRef,
} from "./domain.ts";

export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  { resource: Schema.String, id: Schema.String },
) {}
export class Conflict extends Schema.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  "Conflict",
  { operation: Schema.String, message: Schema.String },
) {}
export class PersistenceError extends Schema.TaggedError<
  PersistenceError,
  { readonly brand: unique symbol }
>()("PersistenceError", { operation: Schema.String, message: Schema.String }) {}
const errors = [
  NotFound.pipe(HttpApiSchema.status(404)),
  Conflict.pipe(HttpApiSchema.status(409)),
  PersistenceError.pipe(HttpApiSchema.status(500)),
];
export const Api = HttpApi.make("HighlightsApi").add(
  HttpApiGroup.make("highlights").add(
    HttpApiEndpoint.post("registerSource", "/sources", {
      payload: SourceRef,
      success: Source,
      error: errors,
    }),
    HttpApiEndpoint.get("getSource", "/sources/:id", {
      params: { id: SourceId },
      success: Source,
      error: errors,
    }),
    HttpApiEndpoint.post("createJob", "/jobs", {
      payload: Schema.Struct({
        sourceId: SourceId,
        spec: Schema.optionalKey(JobSpec),
        force: Schema.optionalKey(Schema.Boolean),
      }),
      success: Job.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
    HttpApiEndpoint.get("listJobs", "/jobs", {
      query: {
        offset: Schema.optionalKey(Schema.NumberFromString),
        limit: Schema.optionalKey(Schema.NumberFromString),
        state: Schema.optionalKey(
          Schema.Literals(["Queued", "Running", "Succeeded", "Partial", "Failed", "Cancelled"]),
        ),
      },
      success: Schema.Struct({ jobs: Schema.Array(Job), total: Count }),
      error: errors,
    }),
    HttpApiEndpoint.get("getJob", "/jobs/:id", {
      params: { id: JobId },
      success: Job,
      error: errors,
    }),
    HttpApiEndpoint.post("cancelJob", "/jobs/:id/cancel", {
      params: { id: JobId },
      success: Job,
      error: errors,
    }),
    HttpApiEndpoint.post("resumeJob", "/jobs/:id/resume", {
      params: { id: JobId },
      payload: Schema.Struct({ retryAmbiguous: Schema.optionalKey(Schema.Boolean) }),
      success: Job,
      error: errors,
    }),
    HttpApiEndpoint.get("getResult", "/jobs/:id/result", {
      params: { id: JobId },
      success: JobResult,
      error: errors,
    }),
    HttpApiEndpoint.get("getBlob", "/blobs/:hash", {
      params: { hash: MediaHash },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: errors,
    }),
    HttpApiEndpoint.get("budget", "/budget", { success: Budget, error: errors }),
  ),
);
