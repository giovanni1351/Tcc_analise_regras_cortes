import { Schema } from "effect";
import { FrameIndex, VideoSeconds } from "@tcc/contracts";
import type { RuleConfig } from "@tcc/contracts";
import { computeWindows, effectiveDuration } from "../domain/rules.ts";

export const StudyVideo = Schema.Struct({
  video_id: Schema.String,
  metadata: Schema.Struct({
    duration_sec: Schema.Number,
    fps: Schema.Number,
    yolo_stride: Schema.Number,
    competition: Schema.String,
    season: Schema.String,
    game: Schema.String,
    half: Schema.Number,
    height: Schema.Number,
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
  events: Schema.Array(Schema.Struct({ time_sec: Schema.Number, label: Schema.String })),
});
export type StudyVideo = typeof StudyVideo.Type;
export const studyLabels = ["Foul", "Goal", "Offside", "Shots off target", "Shots on target"];
const seconds = Schema.decodeUnknownSync(VideoSeconds);
const frame = Schema.decodeUnknownSync(FrameIndex);

export function studyInputs(video: StudyVideo) {
  const { metadata: m } = video;
  return {
    meta: { duration: m.duration_sec, fps: m.fps, stride: m.yolo_stride },
    scenes: video.scenes.map((s) => ({
      sceneId: s.scene_id,
      startSec: seconds(s.start_sec),
      durationSec: s.duration_sec,
      startFrame: frame(Math.round(s.start_sec * m.fps)),
      endFrame: frame(Math.round((s.start_sec + s.duration_sec) * m.fps) - 1),
    })),
    samples: video.samples.map((s) => ({
      sceneId: s.scene_id,
      timeSec: seconds(s.time_sec),
      frameIndex: frame(Math.round(s.time_sec * m.fps)),
      counts: { player: s.player_count ?? NaN, goalkeeper: 0, referee: 0, ball: 0 },
    })),
  };
}

export interface RuleMetrics {
  readonly split: string;
  readonly videos: number;
  readonly games: number;
  readonly durationSec: number;
  readonly hits: number;
  readonly events: number;
  readonly recall: number;
  readonly coverage: number;
  readonly reduction: number;
  readonly proposalPrecision: number;
  readonly proposals: number;
}

export function testGames(games: ReadonlyArray<string>) {
  const sorted = [...new Set(games)].sort();
  return new Set(sorted.length >= 6 ? sorted.filter((_, index) => index % 3 === 0) : []);
}

export function evaluateVideo(
  video: StudyVideo,
  config: RuleConfig,
  labels: ReadonlyArray<string> = studyLabels,
  delta = 0,
) {
  if (!Number.isFinite(delta) || delta < 0)
    throw new RangeError("Event delta must be finite and nonnegative");
  const { scenes, samples, meta } = studyInputs(video);
  const durationSec = effectiveDuration(samples, meta);
  const windows = computeWindows(scenes, samples, meta, config);
  const events = video.events.filter(
    (e) => labels.includes(e.label) && e.time_sec >= 0 && e.time_sec <= durationSec,
  );
  const intersects = (a: number, b: number, t: number) => t + delta >= a && t - delta <= b;
  return {
    game: video.metadata.game,
    durationSec,
    selectedSec: windows.reduce((sum, w) => sum + w.end - w.start, 0),
    hits: events.filter((e) => windows.some((w) => intersects(w.start, w.end, e.time_sec))).length,
    events: events.length,
    proposals: windows.length,
    relevant:
      labels.length === 0
        ? NaN
        : windows.filter((w) => events.some((e) => intersects(w.start, w.end, e.time_sec))).length,
  };
}

export function summarizeRules(
  rows: ReadonlyArray<ReturnType<typeof evaluateVideo>>,
  split: string,
): RuleMetrics {
  const sum = (key: "durationSec" | "selectedSec" | "hits" | "events" | "proposals" | "relevant") =>
    rows.reduce((n, r) => n + r[key], 0);
  const durationSec = sum("durationSec");
  const hits = sum("hits");
  const events = sum("events");
  const proposals = sum("proposals");
  const coverage = durationSec ? sum("selectedSec") / durationSec : NaN;
  return {
    split,
    videos: rows.length,
    games: new Set(rows.map((r) => r.game)).size,
    durationSec,
    hits,
    events,
    recall: events ? hits / events : NaN,
    coverage,
    reduction: 1 - coverage,
    proposalPrecision: proposals ? sum("relevant") / proposals : NaN,
    proposals,
  };
}
