import { expect, it } from "vitest";
import { defaultRuleConfig } from "@tcc/contracts";
import { evaluateVideo, summarizeRules, testGames } from "./rules.ts";
import type { StudyVideo } from "./rules.ts";

const video: StudyVideo = {
  video_id: "v",
  metadata: {
    duration_sec: 100,
    fps: 10,
    yolo_stride: 100,
    competition: "league",
    season: "season",
    game: "game",
    half: 2,
    height: 720,
  },
  scenes: [{ scene_id: 1, start_sec: 10, duration_sec: 1 }],
  samples: [
    { scene_id: 0, time_sec: 0, player_count: 6 },
    ...[10, 10.1, 10.2].map((time_sec) => ({ scene_id: 1, time_sec, player_count: 0 })),
  ],
  events: [
    { label: "Goal", time_sec: 0 },
    { label: "Foul", time_sec: 20.2 },
    { label: "Offside", time_sec: 20.3 },
    { label: "Shots on target", time_sec: 15 },
    { label: "Shots off target", time_sec: 20 },
    { label: "Penalty", time_sec: 10 },
    { label: "Goal", time_sec: -1 },
  ],
};
it("counts target events at inclusive endpoints, with covered duration only", () => {
  const row = evaluateVideo(video, defaultRuleConfig);
  expect(row).toEqual({
    game: "game",
    durationSec: 20.2,
    selectedSec: 20.2,
    hits: 4,
    events: 4,
    proposals: 1,
    relevant: 1,
  });
  expect(summarizeRules([row], "all")).toEqual({
    split: "all",
    videos: 1,
    games: 1,
    durationSec: 20.2,
    hits: 4,
    events: 4,
    recall: 1,
    coverage: 1,
    reduction: 0,
    proposalPrecision: 1,
    proposals: 1,
  });
});
it("returns NaN for empty metric denominators", () => {
  const result = summarizeRules([], "test");
  expect(result.recall).toBeNaN();
  expect(result.coverage).toBeNaN();
  expect(result.proposalPrecision).toBeNaN();
});
it("uses sorted string games at indices 0,3,6 for test, only with six games", () => {
  expect([...testGames(["f", "e", "d", "c", "b", "a", "a"])]).toEqual(["a", "d"]);
  expect([...testGames(["f", "e", "d", "c", "b"])]).toEqual([]);
});
it("allows event tolerance without counting one event twice", () => {
  const changed = {
    ...video,
    metadata: { ...video.metadata, duration_sec: 100, yolo_stride: 1000 },
    events: [{ label: "Goal", time_sec: 27 }],
  };
  expect(evaluateVideo(changed, defaultRuleConfig, ["Goal"], 0).hits).toBe(0);
  expect(evaluateVideo(changed, defaultRuleConfig, ["Goal"], 1).hits).toBe(1);
  expect(() => evaluateVideo(video, defaultRuleConfig, ["Goal"], -1)).toThrow(RangeError);
});

it("returns undefined proposal precision for an empty label selection", () => {
  expect(
    summarizeRules([evaluateVideo(video, defaultRuleConfig, [])], "all").proposalPrecision,
  ).toBeNaN();
});
