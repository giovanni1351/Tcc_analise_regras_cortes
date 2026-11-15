import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { VideoSeconds } from "@tcc/contracts";
import { BlobStore, ClipEncoder, MediaProbe } from "../services.ts";
import { processLayer } from "../process.ts";
import { blobStoreLayer, clipEncoderLayer, commandOutput, mediaProbeLayer } from "./index.ts";

const runtime = processLayer.pipe(Layer.provideMerge(NodeServices.layer));
const seconds = Schema.decodeSync(VideoSeconds);

for (const offset of [0, 2])
  it.live(
    `offset ${offset} probes, publishes idempotently, maps clip PTS and cleans temporary paths`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const source = `${dir}/source.mp4`;
        yield* commandOutput("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=25:duration=3",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=5",
          "-vf",
          `setpts=PTS+${offset}/TB`,
          "-fps_mode",
          "passthrough",
          "-t",
          String(3.2 + offset),
          "-bf",
          "0",
          "-c:v",
          "libx264",
          source,
        ]);
        const layers = Layer.merge(mediaProbeLayer, clipEncoderLayer).pipe(
          Layer.provideMerge(blobStoreLayer(dir)),
        );
        yield* Effect.gen(function* () {
          const probe = yield* MediaProbe;
          const blobs = yield* BlobStore;
          const encoder = yield* ClipEncoder;
          const media = yield* probe.probe(source);
          assert.approximately(media.probe.frameCount, 75, 1);
          assert.approximately(media.probe.fps, 25, 0.5);
          assert.strictEqual(media.sourceStat.size, media.probe.size);
          const encoded = yield* encoder.encode(media, seconds(0.417), seconds(1.8));
          const output = yield* blobs.path(encoded.blob);
          const pts = yield* commandOutput("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
            output,
          ]);
          assert.approximately(encoded.clipStart, 0.44, 0.001);
          assert.approximately(Number(pts.split(",")[0]), 0.04, 1 / 25);
          assert.approximately(encoded.durationSec, 1.4, 1 / 25);
          const repeated = yield* encoder.encode(media, seconds(0.417), seconds(1.8));
          assert.strictEqual(encoded.blob, repeated.blob);
          let temp = "";
          yield* Effect.scoped(
            Effect.gen(function* () {
              temp = yield* blobs.tempPath("mp4");
              yield* fs.writeFileString(temp, "partial");
              return yield* Effect.fail("cancel");
            }),
          ).pipe(Effect.ignore);
          assert.strictEqual(yield* fs.exists(temp), false);
        }).pipe(Effect.provide(layers));
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    { timeout: 30000 },
  );

it.live(
  "rejects a source modified while the hash stream is read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/source.mp4`;
      yield* commandOutput("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=size=32x32:rate=1",
        "-t",
        "1",
        path,
      ]);
      const changingFs = {
        ...fs,
        stream: (file: string) =>
          fs.stream(file).pipe(Stream.tap(() => fs.writeFileString(file, "changed"))),
      };
      const result = yield* Effect.gen(function* () {
        const probe = yield* MediaProbe;
        return yield* probe.probe(path);
      }).pipe(
        Effect.provide(mediaProbeLayer),
        Effect.provideService(FileSystem.FileSystem, changingFs),
        Effect.result,
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.operation, "hash");
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  { timeout: 30000 },
);
