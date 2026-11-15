import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { HttpApiClient } from "effect/http-api";
import { HttpClient } from "effect/http";
import { Api, JobId, SourceId } from "@tcc/contracts";
import { Schema } from "effect";
import { BlobStore } from "../services.ts";
import { Repository } from "../jobs/repository.ts";
import { testServices } from "../jobs/fixtures.testkit.ts";
import { httpLayer } from "../http.ts";
import { byteRange } from "./blobs.ts";

it.effect("byte ranges reject malformed and unsatisfiable values", () =>
  Effect.sync(() => {
    for (const header of [
      "bytes=",
      "bytes=10-",
      "bytes=5-4",
      "bytes=-0",
      "bytes=0-1,3-4",
      "other=1-2",
    ])
      assert.strictEqual(byteRange(header, 10), null, header);
    assert.deepStrictEqual(byteRange("bytes=1-3", 10), { start: 1, end: 3 });
    assert.deepStrictEqual(byteRange("bytes=7-", 10), { start: 7, end: 9 });
    assert.deepStrictEqual(byteRange("bytes=-4", 10), { start: 6, end: 9 });
    assert.deepStrictEqual(byteRange("bytes=0-99", 10), { start: 0, end: 9 });
    assert.strictEqual(byteRange("bytes=0-", 0), null);
  }),
);

it.live(
  "generated client drives sources, jobs, cancel, resume and result; blobs stream ranges",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api);
      const http = yield* HttpClient.HttpClient;
      const repo = yield* Repository;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/video.bin`;
      yield* fs.writeFileString(path, "video");
      const source = yield* client.highlights.registerSource({
        payload: { _tag: "LocalFile", path },
      });
      assert.deepStrictEqual(
        yield* client.highlights.getSource({ params: { id: source.id } }),
        source,
      );
      const job = yield* client.highlights.createJob({ payload: { sourceId: source.id } });
      assert.strictEqual(
        (yield* client.highlights.createJob({ payload: { sourceId: source.id } })).id,
        job.id,
      );
      assert.strictEqual(
        (yield* client.highlights.getJob({ params: { id: job.id } })).state._tag,
        "Queued",
      );
      assert.strictEqual(
        (yield* client.highlights.listJobs({ query: { state: "Queued", limit: 1 } })).total,
        1,
      );
      assert.deepStrictEqual(
        (yield* client.highlights.getResult({ params: { id: job.id } })).highlights,
        [],
      );
      yield* repo.change(job.id, { _tag: "Start" });
      yield* repo.change(job.id, {
        _tag: "Complete",
        state: {
          _tag: "Partial",
          coverage: { segments: 1, valid: 0, invalid: 0, ambiguous: 1, notSent: 0 },
          reason: { _tag: "AmbiguousAttempts", count: 1 },
        },
      });
      assert.strictEqual(
        (yield* client.highlights.resumeJob({
          params: { id: job.id },
          payload: { retryAmbiguous: true },
        })).state._tag,
        "Queued",
      );
      assert.strictEqual(
        (yield* client.highlights.cancelJob({ params: { id: job.id } })).state._tag,
        "Cancelled",
      );
      const illegal = yield* client.highlights
        .resumeJob({ params: { id: job.id }, payload: {} })
        .pipe(Effect.result);
      assert.strictEqual(illegal._tag, "Failure");
      if (illegal._tag === "Failure") assert.strictEqual(illegal.failure._tag, "Conflict");
      const missing = yield* client.highlights
        .getSource({ params: { id: yield* Schema.decodeEffect(SourceId)("missing") } })
        .pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      if (missing._tag === "Failure") assert.strictEqual(missing.failure._tag, "NotFound");
      const missingJob = yield* client.highlights
        .getJob({ params: { id: yield* Schema.decodeEffect(JobId)("missing") } })
        .pipe(Effect.result);
      assert.strictEqual(missingJob._tag, "Failure");
      const blobs = yield* BlobStore;
      const temp = yield* blobs.tempPath("bin");
      yield* fs.writeFileString(temp, "0123456789");
      const hash = yield* blobs.publish(temp, "bin");
      const binary = yield* client.highlights.getBlob({ params: { hash } }).pipe(Effect.result);
  assert.strictEqual(binary._tag, "Success");
  const complete = yield* http.get(`/blobs/${hash}`);
      assert.strictEqual(complete.status, 200);
      assert.strictEqual(yield* complete.text, "0123456789");
      for (const [range, expected] of [
        ["bytes=2-4", "234"],
        ["bytes=7-", "789"],
        ["bytes=-2", "89"],
      ]) {
        const response = yield* http.get(`/blobs/${hash}`, { headers: { range: range ?? "" } });
        assert.strictEqual(response.status, 206);
        assert.strictEqual(yield* response.text, expected);
        assert.match(response.headers["content-range"] ?? "", /^bytes \d+-\d+\/10$/);
      }
      const unsatisfied = yield* http.get(`/blobs/${hash}`, { headers: { range: "bytes=10-" } });
      assert.strictEqual(unsatisfied.status, 416);
      assert.strictEqual(unsatisfied.headers["content-range"], "bytes */10");
    }).pipe(
      Effect.scoped,
      Effect.provide(httpLayer.pipe(Layer.provideMerge(testServices))),
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provide(NodeServices.layer),
    ),
);
