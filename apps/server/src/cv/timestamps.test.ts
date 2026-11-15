import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { commandOutput } from "../media/index.ts";
import { processLayer } from "../process.ts";

it.live("V6 VFR scene boundaries and samples follow real frame PTS", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = `${dir}/vfr.mkv`;
    yield* commandOutput("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=25:duration=2",
      "-vf",
      "select='if(lt(n,25),1,not(mod(n,5)))'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "ffv1",
      file,
    ]);
    const output = yield* commandOutput("python", [
      "-c",
      `
import json, subprocess
from workers.cv.worker import frame_timeline, map_times
path = ${JSON.stringify(file)}
frames = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',path]))['frames']
pts = [float(f['best_effort_timestamp_time']) for f in frames]
timeline = frame_timeline(path, 25)
assert timeline is not None
samples = [dict(frameIndex=i,timeSec=i/25) for i in range(len(pts))]
scenes = [dict(startFrame=24,endFrame=28,startSec=24/25,durationSec=5/25)]
map_times('detections',samples,timeline)
map_times('scenes',scenes,timeline)
for sample, expected in zip(samples,pts):
    assert abs(sample['timeSec']-expected) < .04
assert abs(scenes[0]['startSec']-pts[24]) < .04
assert abs(scenes[0]['durationSec']-(pts[29]-pts[24])) < .04
print('verified')
`,
    ]);
    assert.strictEqual(output.trim(), "verified");
  }).pipe(Effect.scoped, Effect.provide(processLayer), Effect.provide(NodeServices.layer)),
);
