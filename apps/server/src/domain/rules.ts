import { Schema } from "effect";
import { RuleConfig, VideoSeconds } from "@tcc/contracts";
import type { CandidateWindow, Sample, Scene } from "../services.ts";

export interface RuleMeta {
  readonly duration: number;
  readonly fps: number;
  readonly stride: number;
}

export interface RuleSample extends Sample {
  readonly sceneId?: number | null;
}

const seconds = Schema.decodeUnknownSync(VideoSeconds);

export function effectiveDuration(samples: ReadonlyArray<Sample>, meta: RuleMeta) {
  const last = samples.reduce((latest, s) => Math.max(latest, s.timeSec), 0);
  return samples.length === 0 ? 0 : Math.min(meta.duration, last + meta.stride / meta.fps);
}

export function computeWindows(
  scenes: ReadonlyArray<Scene>,
  samples: ReadonlyArray<RuleSample>,
  meta: RuleMeta,
  config: RuleConfig,
): ReadonlyArray<CandidateWindow> {
  Schema.decodeSync(RuleConfig)(config);
  const sorted = samples.toSorted((a, b) => a.timeSec - b.timeSec);
  const duration = effectiveDuration(sorted, meta);
  const groups = new Map<number, number[]>();
  const sums = [0];
  const missing = [0];
  for (const sample of sorted) {
    let sceneId = sample.sceneId;
    if (sceneId === undefined) {
      for (const scene of scenes) {
        if (sample.frameIndex >= scene.startFrame && sample.frameIndex <= scene.endFrame) {
          sceneId = scene.sceneId;
        }
      }
    }
    if (sceneId !== undefined && sceneId !== null) {
      const group = groups.get(sceneId) ?? [];
      group.push(sample.counts.player);
      groups.set(sceneId, group);
    }
    sums.push(
      sums[sums.length - 1]! + (Number.isNaN(sample.counts.player) ? 0 : sample.counts.player),
    );
    missing.push(missing[missing.length - 1]! + Number(Number.isNaN(sample.counts.player)));
  }
  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.timeSec < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const qualified = scenes
    .filter((scene) => {
      const players = groups.get(scene.sceneId) ?? [];
      if (scene.durationSec > config.short || players.length < 3 || scene.startSec >= duration)
        return false;
      const lo = lowerBound(scene.startSec - 15);
      const hi = lowerBound(scene.startSec);
      const previous =
        hi > lo && missing[hi] === missing[lo] ? (sums[hi]! - sums[lo]!) / (hi - lo) : NaN;
      if (config._tag === "Zero") {
        return (
          (!config.use_zero ||
            players.filter((p) => p === 0).length / players.length >= config.zero) &&
          (!config.preceding || previous >= 6)
        );
      }
      const present = players.filter((p) => !Number.isNaN(p));
      const mean = present.reduce((a, b) => a + b, 0) / present.length;
      return previous >= config.min_previous && mean <= previous * (1 - config.drop_fraction);
    })
    .map((s) => s.startSec)
    .sort((a, b) => a - b);
  const anchors =
    config.cluster <= 1
      ? qualified
      : qualified.filter(
          (start) =>
            qualified.filter((other) => other >= start - 10 && other <= start + 10).length >=
            config.cluster,
        );
  const windows: Array<{ start: VideoSeconds; end: VideoSeconds; anchors: VideoSeconds[] }> = [];
  for (const anchor of anchors) {
    const start = seconds(Math.max(0, anchor - config.before));
    const end = seconds(Math.min(duration, anchor + config.after));
    const last = windows[windows.length - 1];
    if (last && start <= last.end) {
      last.end = seconds(Math.max(last.end, end));
      last.anchors.push(anchor);
    } else windows.push({ start, end, anchors: [anchor] });
  }
  return windows;
}
