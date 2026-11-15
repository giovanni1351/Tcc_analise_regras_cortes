import fixture1 from "../../../../fixtures/rule-config-c/fixture-1.json" with { type: "json" };
import fixture2 from "../../../../fixtures/rule-config-c/fixture-2.json" with { type: "json" };
import fixture3 from "../../../../fixtures/rule-config-c/fixture-3.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { defaultRuleConfig, FrameIndex, VideoSeconds } from "@tcc/contracts";
import { computeWindows } from "./rules.ts";
import type { RuleSample } from "./rules.ts";
import type { Scene } from "../services.ts";

const sec = Schema.decodeUnknownSync(VideoSeconds);
const frame = Schema.decodeUnknownSync(FrameIndex);
const Fixture = Schema.Struct({
  metadata: Schema.Struct({
    duration_sec: Schema.Number,
    fps: Schema.Number,
    yolo_stride: Schema.Number,
  }),
  scenes: Schema.Array(
    Schema.Struct({
      scene_id: Schema.Number,
      start_sec: Schema.Number,
      duration_sec: Schema.Number,
    }),
  ),
  samples: Schema.Array(
    Schema.Struct({
      scene_id: Schema.NullOr(Schema.Number),
      time_sec: Schema.Number,
      player_count: Schema.NullOr(Schema.Number),
    }),
  ),
  windows: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
});

describe("Python config C fixtures", () => {
  it.each([1, 2, 3])("matches fixture %s within 1 ms", (n) => {
    const fixture = Schema.decodeUnknownSync(Fixture)([fixture1, fixture2, fixture3][n - 1]);
    const fps = fixture.metadata.fps;
    const scenes: Scene[] = fixture.scenes.map((s) => ({
      sceneId: s.scene_id,
      startSec: sec(s.start_sec),
      durationSec: s.duration_sec,
      startFrame: frame(Math.round(s.start_sec * fps)),
      endFrame: frame(Math.round((s.start_sec + s.duration_sec) * fps) - 1),
    }));
    const samples: RuleSample[] = fixture.samples.map((s) => ({
      sceneId: s.scene_id,
      timeSec: sec(s.time_sec),
      frameIndex: frame(Math.round(s.time_sec * fps)),
      counts: { player: s.player_count ?? NaN, goalkeeper: 0, referee: 0, ball: 0 },
    }));
    const windows = computeWindows(
      scenes,
      samples,
      { duration: fixture.metadata.duration_sec, fps, stride: fixture.metadata.yolo_stride },
      defaultRuleConfig,
    );
    expect(windows).toHaveLength(fixture.windows.length);
    windows.forEach((w, i) => {
      expect(Math.abs(w.start - fixture.windows[i]![0])).toBeLessThanOrEqual(0.001);
      expect(Math.abs(w.end - fixture.windows[i]![1])).toBeLessThanOrEqual(0.001);
    });
    expect(
      computeWindows(
        scenes,
        samples.map(({ sceneId: _sceneId, ...sample }) => sample),
        { duration: fixture.metadata.duration_sec, fps, stride: fixture.metadata.yolo_stride },
        defaultRuleConfig,
      ),
    ).toEqual(windows);
  });
});

const scene = (id: number, start: number, duration = 1): Scene => ({
  sceneId: id,
  startSec: sec(start),
  durationSec: duration,
  startFrame: frame(start * 10),
  endFrame: frame((start + duration) * 10 - 1),
});
const sample = (t: number, player: number, sceneId: number): RuleSample => ({
  sceneId,
  timeSec: sec(t),
  frameIndex: frame(Math.round(t * 10)),
  counts: { player, goalkeeper: 100, referee: 100, ball: 100 },
});
const samples = [sample(0, 6, 0), sample(10, 0, 1), sample(10.1, 0, 1), sample(10.2, 0, 1)];
const meta = { duration: 100, fps: 10, stride: 1 };
it("clamps to sample coverage and ignores goalkeeper counts", () => {
  expect(computeWindows([scene(1, 10)], samples, meta, defaultRuleConfig)).toEqual([
    { start: 0, end: sec(10.2 + 0.1), anchors: [10] },
  ]);
});
it("NaN preceding counts fail both rules", () => {
  const input = [sample(0, NaN, 0), ...samples.slice(1)];
  expect(computeWindows([scene(1, 10)], input, meta, defaultRuleConfig)).toEqual([]);
  expect(
    computeWindows([scene(1, 10)], input, meta, {
      _tag: "Context",
      short: 25,
      cluster: 1,
      before: 1,
      after: 1,
      min_previous: 6,
      drop_fraction: 0.65,
    }),
  ).toEqual([]);
});
it("context uses inclusive thresholds and ignores missing scene counts for means", () => {
  expect(
    computeWindows(
      [scene(1, 10, 25)],
      [sample(0, 6, 0), sample(10, 3, 1), sample(10.1, NaN, 1), sample(10.2, 3, 1)],
      meta,
      {
        _tag: "Context",
        short: 25,
        cluster: 1,
        before: 1,
        after: 1,
        min_previous: 6,
        drop_fraction: 0.5,
      },
    ),
  ).toHaveLength(1);
});
it("cluster counts duplicate starts and touching intervals merge", () => {
  const ss = [scene(1, 10), scene(2, 20), scene(3, 20)];
  const input = [1, 2, 3].flatMap((id) =>
    [0, 0.1, 0.2].map((offset) => sample((id === 1 ? 10 : 20) + offset, 0, id)),
  );
  expect(
    computeWindows(
      ss,
      input,
      { ...meta, stride: 100 },
      { ...defaultRuleConfig, preceding: false, cluster: 3, before: 5, after: 5 },
    ),
  ).toEqual([{ start: 5, end: 25, anchors: [10, 20, 20] }]);
});
it("empty inputs produce no windows", () =>
  expect(computeWindows([], [], meta, defaultRuleConfig)).toEqual([]));
