import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { migrate } from "./migrations.ts";

export const databaseLayer = (filename: string) => {
  const sqlite = SqliteClient.layer({ filename });
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys=ON`;
      yield* migrate;
    }),
  ).pipe(Layer.provideMerge(sqlite));
};
