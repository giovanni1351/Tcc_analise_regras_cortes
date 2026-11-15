import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";

export class DataDirectoryLocked extends Schema.TaggedError<
  DataDirectoryLocked,
  { readonly brand: unique symbol }
>()("DataDirectoryLocked", { path: Schema.String, cause: Schema.Defect() }) {}

export const acquireDataDirectoryLock = Effect.fn("DataDirectory.lock")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  const path = `${directory}/server.lock`;
  const context = yield* Layer.build(
    SqliteClient.layer({ filename: path, disableWAL: true, busyTimeout: 0 }),
  ).pipe(Effect.mapError((cause) => new DataDirectoryLocked({ path, cause })));
  const sql = Context.get(context, SqliteClient.SqliteClient);
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA locking_mode=EXCLUSIVE`;
    yield* sql`BEGIN EXCLUSIVE`;
    yield* sql`CREATE TABLE IF NOT EXISTS server_lock (id INTEGER PRIMARY KEY)`;
    yield* sql`COMMIT`;
  }).pipe(Effect.mapError((cause) => new DataDirectoryLocked({ path, cause })));
});
