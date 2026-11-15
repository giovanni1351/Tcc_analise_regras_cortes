import { Schema } from "effect";
import { SourceRef, NonNegative, Count } from "@tcc/contracts";
import catalog from "./study-halves.json" with { type: "json" };

const StudyHalf = Schema.Struct({
  ...SourceRef.members[1].fields,
  duration: NonNegative,
  scenes: Count,
  workbook: Schema.String,
});
export const studyHalves = Schema.decodeUnknownSync(Schema.Array(StudyHalf))(
  catalog.map((half) => ({ ...half, _tag: "SoccerNetHalf" })),
);
export type StudyHalf = typeof StudyHalf.Type;
export function splitHalves(halves: ReadonlyArray<StudyHalf>) {
  const games = [...new Set(halves.map((h) => h.game))].sort();
  const testGames = new Set(games.length >= 6 ? games.filter((_, i) => i % 3 === 0) : []);
  return {
    train: halves.filter((h) => !testGames.has(h.game)),
    test: halves.filter((h) => testGames.has(h.game)),
  };
}
export const studySplit = splitHalves(studyHalves);
