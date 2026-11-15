import { assert, it } from "@effect/vitest";
import { studyHalves, studySplit, splitHalves } from "./split.ts";
it("reproduces the study game split without leaking halves across groups", () => {
  assert.strictEqual(studyHalves.length, 1000);
  const games = [...new Set(studyHalves.map((h) => h.game))].sort();
  assert.strictEqual(games.length, 500);
  assert.ok(
    studySplit.test.some(
      (h) => h.game === "2015-02-21 - 18-00 Chelsea 1 - 1 Burnley" && h.half === 1,
    ),
  );
  assert.ok(
    studySplit.train.some(
      (h) => h.game === "2015-02-21 - 18-00 Crystal Palace 1 - 2 Arsenal" && h.half === 2,
    ),
  );
  for (const index of [0, 3, 6]) {
    assert.ok(studySplit.test.some((h) => h.game === games[index]));
    assert.ok(!studySplit.train.some((h) => h.game === games[index]));
  }
  assert.ok(studySplit.train.some((h) => h.game === games[1]));
  assert.strictEqual(splitHalves(studyHalves.slice(0, 2)).test.length, 0);
});
