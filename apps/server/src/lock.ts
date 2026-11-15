import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class DataDirectoryLocked extends Schema.TaggedError<
  DataDirectoryLocked,
  { readonly brand: unique symbol }
>()("DataDirectoryLocked", { path: Schema.String, cause: Schema.Defect() }) {}

export const acquireDataDirectoryLock = Effect.fn("DataDirectory.lock")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(directory, { recursive: true });
  const path = `${directory}/server.lock`;
  // flock releases on process exit; stdin EOF also releases it if the server crashes.
  const child = yield* spawner
    .spawn(
      ChildProcess.make("flock", [
        "--nonblock",
        "--conflict-exit-code",
        "73",
        path,
        "sh",
        "-c",
        "printf locked; cat",
      ]),
    )
    .pipe(Effect.mapError((cause) => new DataDirectoryLocked({ path, cause })));
  const ready = yield* Stream.runHead(child.stdout).pipe(
    Effect.mapError((cause) => new DataDirectoryLocked({ path, cause })),
  );
  if (Option.isNone(ready))
    return yield* new DataDirectoryLocked({ path, cause: "Exclusive lock unavailable" });
  return child;
});
