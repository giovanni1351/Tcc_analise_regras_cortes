import { Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { migrate } from "./migrations.ts";

export const databaseLayer = (filename: string) => {
  const sqlite = SqliteClient.layer({ filename });
  return Layer.effectDiscard(migrate).pipe(Layer.provideMerge(sqlite));
};
