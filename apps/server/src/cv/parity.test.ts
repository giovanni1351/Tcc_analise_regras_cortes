import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Logger, Path, References, Schema } from "effect";
import { FrameIndex, VideoSeconds } from "@tcc/contracts";
import { MediaProbe, SceneDetector, ObjectDetector } from "../services.ts";
import { processLayer } from "../process.ts";
import { commandOutput, mediaProbeLayer } from "../media/index.ts";
import { cvLayer } from "./index.ts";

const Reference = Schema.fromJsonString(
  Schema.Struct({
    scenes: Schema.Array(
      Schema.Struct({
        scene_id: Schema.Number,
        start_frame: FrameIndex,
        end_frame: FrameIndex,
        start_sec: VideoSeconds,
        duration_sec: Schema.Number,
      }),
    ),
    detections: Schema.Array(
      Schema.Struct({
        frame: FrameIndex,
        time_sec: VideoSeconds,
        player_count: Schema.Number,
        goalkeeper_count: Schema.Number,
        referee_count: Schema.Number,
        ball_count: Schema.Number,
      }),
    ),
  }),
);

it.live(
  "CUDA worker matches direct Python on a generated 60 second clip",
  (context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = paths.resolve(".");
      const source = yield* Config.String("TCC_CV_TEST_VIDEO").pipe(
        Config.withDefault(
          "/home/pedro/tcc/benchmark/downloads/england_epl/2016-2017/2017-01-02 - 18-00 Sunderland 2 - 2 Liverpool/2_224p.mkv",
        ),
      );
      if (!(yield* fs.exists(source)) || !(yield* fs.exists(`${root}/.venv/bin/python`))) {
        context.skip();
        return;
      }
      const available = yield* commandOutput(`${root}/.venv/bin/python`, [
        `${root}/workers/cv/reference.py`,
      ]);
      const cuda = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ cuda: Schema.Boolean })),
      )(available).pipe(Effect.orDie);
      if (!cuda.cuda) {
        context.skip();
        return;
      }
      const dir = yield* fs.makeTempDirectoryScoped();
      const clip = `${dir}/clip60.mp4`;
      yield* commandOutput("ffmpeg", [
        "-v",
        "error",
        "-i",
        source,
        "-frames:v",
        "1500",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        clip,
      ]);
      const referenceJson = yield* commandOutput(`${root}/.venv/bin/python`, [
        `${root}/workers/cv/reference.py`,
        clip,
      ]);
      const reference = yield* Schema.decodeEffect(Reference)(referenceJson).pipe(Effect.orDie);
      yield* Effect.gen(function* () {
        const media = yield* (yield* MediaProbe).probe(clip);
        const scenes = yield* (yield* SceneDetector).detect(media);
        const detections = yield* (yield* ObjectDetector).detect(media, 5, () => Effect.void);
        assert.strictEqual(scenes.device, "cuda");
        assert.strictEqual(detections.device, "cuda");
        assert.deepStrictEqual(
          scenes.items,
          reference.scenes.map((row) => ({
            sceneId: row.scene_id,
            startFrame: row.start_frame,
            endFrame: row.end_frame,
            startSec: row.start_sec,
            durationSec: row.duration_sec,
          })),
        );
        assert.deepStrictEqual(
          detections.items,
          reference.detections.map((row) => ({
            frameIndex: row.frame,
            timeSec: row.time_sec,
            counts: {
              player: row.player_count,
              goalkeeper: row.goalkeeper_count,
              referee: row.referee_count,
              ball: row.ball_count,
            },
          })),
        );
        yield* Effect.log(
          `CUDA parity PASS. ${media.probe.frameCount} frames, ${scenes.items.length} scenes, ${detections.items.length} samples. Boundaries and all four counts identical.`,
        );
      }).pipe(Effect.provide(Layer.merge(mediaProbeLayer, cvLayer(root))));
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([Logger.consoleLogFmt])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(processLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  { timeout: 300000 },
);
