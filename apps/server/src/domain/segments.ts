import { Option, Schema } from "effect";
import { VideoSeconds } from "@tcc/contracts";
import type { CandidateWindow, ClipPrediction, PlannedSegment } from "../services.ts";

const seconds = Schema.decodeUnknownSync(VideoSeconds);

export function planSegments(
  windows: ReadonlyArray<CandidateWindow>,
  { maxSec = 40, overlapSec = 5 } = {},
): ReadonlyArray<PlannedSegment> {
  if (
    !Number.isFinite(maxSec) ||
    !Number.isFinite(overlapSec) ||
    maxSec <= 0 ||
    overlapSec < 0 ||
    overlapSec >= maxSec
  ) {
    throw new RangeError("Require 0 <= overlapSec < maxSec");
  }
  return windows.flatMap((window, windowIndex) => {
    const segments: PlannedSegment[] = [];
    let start = window.start;
    while (start < window.end) {
      const end = seconds(Math.min(start + maxSec, window.end));
      segments.push({ windowIndex, start, end });
      if (end === window.end) break;
      start = seconds(end - overlapSec);
    }
    return segments;
  });
}

export function toVideoSeconds(
  clipStart: VideoSeconds,
  t: number,
  clipDuration: number,
): Option.Option<VideoSeconds> {
  return Number.isFinite(t) && t >= 0 && t <= clipDuration
    ? Option.some(seconds(clipStart + t))
    : Option.none();
}

export interface MergedPrediction {
  readonly segmentIndex: number;
  readonly eventClass: ClipPrediction["eventClass"];
  readonly videoSeconds: VideoSeconds;
  readonly confidence: number;
  readonly predictionIndices: ReadonlyArray<number>;
}

export function mergeOverlaps(
  predictions: ReadonlyArray<ClipPrediction>,
  segments: ReadonlyArray<PlannedSegment>,
): ReadonlyArray<MergedPrediction> {
  const mapped = predictions.flatMap((p, index) => {
    const segment = segments[p.segmentIndex];
    if (!segment) return [];
    const t = toVideoSeconds(segment.start, p.t, segment.end - segment.start);
    return Option.isSome(t) ? [{ ...p, index, videoSeconds: t.value }] : [];
  });
  const pairs: Array<{ a: (typeof mapped)[number]; b: (typeof mapped)[number]; distance: number }> =
    [];
  const ordered = segments
    .map((s, index) => ({ ...s, index }))
    .sort((a, b) => a.windowIndex - b.windowIndex || a.start - b.start || a.index - b.index);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    if (a.windowIndex !== b.windowIndex) continue;
    const lo = Math.max(a.start, b.start);
    const hi = Math.min(a.end, b.end);
    if (lo > hi) continue;
    const left = mapped.filter(
      (p) => p.segmentIndex === a.index && p.videoSeconds >= lo && p.videoSeconds <= hi,
    );
    const right = mapped.filter(
      (p) => p.segmentIndex === b.index && p.videoSeconds >= lo && p.videoSeconds <= hi,
    );
    for (const x of left)
      for (const y of right) {
        if (x.eventClass === y.eventClass)
          pairs.push({ a: x, b: y, distance: Math.abs(x.videoSeconds - y.videoSeconds) });
      }
  }
  pairs.sort(
    (x, y) =>
      x.distance - y.distance ||
      Math.max(y.a.confidence, y.b.confidence) - Math.max(x.a.confidence, x.b.confidence) ||
      x.a.segmentIndex - y.a.segmentIndex ||
      x.a.index - y.a.index ||
      x.b.index - y.b.index,
  );
  const used = new Set<number>();
  const highlights: MergedPrediction[] = [];
  const emit = (p: (typeof mapped)[number], indices: number[]) =>
    highlights.push({
      segmentIndex: p.segmentIndex,
      eventClass: p.eventClass,
      videoSeconds: p.videoSeconds,
      confidence: p.confidence,
      predictionIndices: indices,
    });
  for (const { a, b } of pairs) {
    if (used.has(a.index) || used.has(b.index)) continue;
    used.add(a.index);
    used.add(b.index);
    emit(a.confidence >= b.confidence ? a : b, [a.index, b.index]);
  }
  for (const p of mapped) if (!used.has(p.index)) emit(p, [p.index]);
  return highlights.sort(
    (a, b) =>
      a.videoSeconds - b.videoSeconds ||
      a.segmentIndex - b.segmentIndex ||
      a.predictionIndices[0]! - b.predictionIndices[0]!,
  );
}
