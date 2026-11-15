import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import {
  BadRequest,
  PersistenceError,
  Conflict,
  JobError,
  type SourceId,
  type SourceRef,
  type StageName,
} from "@tcc/contracts";
import { SqlClient } from "effect/sql";
import { ProcessError } from "../process.ts";
import { MediaError, MediaProbe } from "../services.ts";
import { Repository, persistence } from "./repository.ts";

export const makeSources = Effect.fn("Sources.make")(function* (soccerNetRoot: string) {
  const repo = yield* Repository;
  const sql = yield* SqlClient.SqlClient;
  const probe = yield* MediaProbe;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolve = (ref: SourceRef) =>
    ref._tag === "LocalFile"
      ? path.resolve(ref.path)
      : path.join(
          soccerNetRoot,
          ref.league,
          ref.season,
          ref.game,
          `${ref.half}_${ref.resolution}.mkv`,
        );
  const inspect = Effect.fn("Sources.inspect")(function* (file: string) {
    const info = yield* fs.stat(file).pipe(persistence("statSource"));
    return {
      size: Number(info.size),
      mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
    };
  });
  const register = Effect.fn("Sources.register")(function* (ref: SourceRef) {
    if (
      ref._tag === "SoccerNetHalf" &&
      [ref.league, ref.season, ref.game].some(
        (part) => part === "" || part === "." || part === ".." || /[/\\]/.test(part),
      )
    )
      return yield* new BadRequest({
        operation: "registerSource",
        message: "SoccerNet path components must be single directory names",
      });
    const file = resolve(ref);
    if (!(yield* fs.exists(file).pipe(persistence("statSource"))))
      return yield* new BadRequest({
        operation: "registerSource",
        message: "Source file does not exist",
      });
    const before = yield* inspect(file);
    const media = yield* probe.probe(file).pipe(
      Effect.mapError((cause) => {
        let origin: unknown = cause;
        while (Schema.is(MediaError)(origin)) origin = origin.cause;
        return Schema.is(ProcessError)(origin)
          ? new PersistenceError({ operation: "probe", message: String(cause) })
          : new BadRequest({ operation: "probe", message: String(cause) });
      }),
    );
    const after = yield* inspect(file);
    if (before.size !== after.size || before.mtime !== after.mtime)
      return yield* new Conflict({
        operation: "registerSource",
        message: "Source changed during registration",
      });
    return yield* repo.register(
      ref._tag === "LocalFile" ? { ...ref, path: file } : ref,
      media.hash,
      media.probe,
      after.size,
      after.mtime,
    );
  });
  const check = Effect.fn("Sources.check")(function* (id: SourceId, stage: StageName) {
    const source = yield* repo.source(id);
    const file = resolve(source.ref);
    const info = yield* inspect(file);
    const rows = yield* sql<{
      size: number;
      mtime_ms: number;
    }>`SELECT size,mtime_ms FROM sources WHERE id=${id}`.pipe(persistence("sourceMetadata"));
    if (rows[0]?.size === info.size && rows[0]?.mtime_ms === info.mtime)
      return {
        path: file,
        hash: source.mediaHash,
        probe: source.probe,
        sourceStat: { size: info.size, mtimeMs: info.mtime },
      };
    const media = yield* probe.probe(file).pipe(persistence("checkSource"));
    if (media.hash !== source.mediaHash)
      return yield* new JobError({
        stage,
        category: "SourceChanged",
        message: `Source ${id} changed`,
      });
    const after = yield* inspect(file);
    if (after.size !== info.size || after.mtime !== info.mtime)
      return yield* new JobError({
        stage,
        category: "SourceChanged",
        message: `Source ${id} changed while hashing`,
      });
    yield* sql`UPDATE sources SET size=${info.size},mtime_ms=${info.mtime} WHERE id=${id}`.pipe(
      persistence("refreshSource"),
    );
    return media;
  });
  return { register, check };
});
export class Sources extends Context.Service<
  Sources,
  Effect.Success<ReturnType<typeof makeSources>>
>()("@tcc/server/jobs/sources") {}
export const sourcesLayer = (root = "/home/pedro/tcc/benchmark/downloads") =>
  Layer.effect(Sources, makeSources(root));
