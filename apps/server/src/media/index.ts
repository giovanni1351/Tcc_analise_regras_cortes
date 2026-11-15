// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { MediaHash, Probe, VideoSeconds } from "@tcc/contracts";
import { BlobStore, ClipEncoder, MediaError, MediaProbe } from "../services.ts";
import type { ProbedMedia } from "../services.ts";
import { Process } from "../process.ts";

const commandCapture = Effect.fn("Media.commandCapture")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const process = yield* Process;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* process.spawn(command, args);
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => (a + b).slice(0, 32768),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* new MediaError({
          operation: command,
          path: args.at(-1) ?? "",
          cause: stderr,
        });
      return { stdout, stderr };
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new MediaError({ operation: command, path: args.at(-1) ?? "", cause }),
    ),
  );
});

export const commandOutput = Effect.fn("Media.commandOutput")(
  (command: string, args: ReadonlyArray<string>) =>
    commandCapture(command, args).pipe(Effect.map((result) => result.stdout)),
);

const hashed = Effect.fn("Media.hash")(function* (path: string) {
  const failure = (cause: unknown) => new MediaError({ operation: "hash", path, cause });
  const fs = yield* FileSystem.FileSystem;
  const before = yield* fs.stat(path).pipe(Effect.mapError(failure));
  const digest = createHash("sha256");
  yield* fs.stream(path).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        digest.update(chunk);
      }),
    ),
    Effect.mapError(failure),
  );
  const after = yield* fs.stat(path).pipe(Effect.mapError(failure));
  const mtimeMs = yield* Option.match(before.mtime, {
    onNone: () =>
      Effect.fail(new MediaError({ operation: "hash", path, cause: "Missing modification time" })),
    onSome: (time) => Effect.succeed(time.getTime()),
  });
  if (before.size !== after.size || Option.getOrNull(after.mtime)?.getTime() !== mtimeMs)
    return yield* new MediaError({
      operation: "hash",
      path,
      cause: "Source changed during hashing",
    });
  const hash = yield* Schema.decodeEffect(MediaHash)(digest.digest("hex")).pipe(
    Effect.mapError(failure),
  );
  return { hash, sourceStat: { size: Number(before.size), mtimeMs } };
});

const Ffprobe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      avg_frame_rate: Schema.String,
      nb_read_frames: Schema.String,
      start_time: Schema.optional(Schema.String),
    }),
  ),
  format: Schema.Struct({ duration: Schema.String, start_time: Schema.optional(Schema.String) }),
});
const probeFile = Effect.fn("Media.ffprobe")(function* (path: string) {
  const json = yield* commandOutput("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=avg_frame_rate,nb_read_frames,start_time:format=duration,start_time",
    "-of",
    "json",
    path,
  ]);
  return yield* Schema.decodeEffect(Schema.fromJsonString(Ffprobe))(json).pipe(
    Effect.mapError((cause) => new MediaError({ operation: "ffprobe", path, cause })),
  );
});

export const mediaProbeLayer = Layer.effect(
  MediaProbe,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* Process;
    return {
      probe: Effect.fn("MediaProbe.probe")(function* (path: string) {
        const before = yield* fs
          .stat(path)
          .pipe(Effect.mapError((cause) => new MediaError({ operation: "probe", path, cause })));
        const metadata = yield* probeFile(path).pipe(Effect.provideService(Process, process));
        const identity = yield* hashed(path).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        if (
          Number(before.size) !== identity.sourceStat.size ||
          Option.getOrNull(before.mtime)?.getTime() !== identity.sourceStat.mtimeMs
        )
          return yield* new MediaError({
            operation: "probe",
            path,
            cause: "Source changed while probing",
          });
        const stream = metadata.streams[0];
        if (!stream)
          return yield* new MediaError({ operation: "probe", path, cause: "No video stream" });
        const [numerator, denominator] = stream.avg_frame_rate.split("/").map(Number);
        const probe = yield* Schema.decodeEffect(Probe)({
          duration: Number(metadata.format.duration),
          fps: Number(numerator) / Number(denominator),
          frameCount: Number(stream.nb_read_frames),
          size: identity.sourceStat.size,
        }).pipe(Effect.mapError((cause) => new MediaError({ operation: "probe", path, cause })));
        return { path, ...identity, probe };
      }),
    };
  }),
);

export const blobStoreLayer = (dataDir: string) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(dataDir, "blobs", "sha256");
      const extValid = Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,10}$/));
      const extension = Effect.fn("BlobStore.extension")((ext: string) =>
        Schema.decodeEffect(extValid)(ext).pipe(
          Effect.mapError((cause) => new MediaError({ operation: "extension", path: ext, cause })),
        ),
      );
      return {
        tempPath: Effect.fn("BlobStore.tempPath")(
          function* (ext: string) {
            yield* extension(ext);
            yield* fs.makeDirectory(root, { recursive: true });
            const dir = yield* fs.makeTempDirectoryScoped({ directory: root });
            return path.join(dir, `pending.${ext}`);
          },
          Effect.mapError((cause) => new MediaError({ operation: "tempPath", path: root, cause })),
        ),
        publish: Effect.fn("BlobStore.publish")(
          function* (temp: string, ext: string) {
            yield* extension(ext);
            const { hash } = yield* hashed(temp).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
            );
            const dir = path.join(root, hash.slice(0, 2));
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.rename(temp, path.join(dir, `${hash}.${ext}`));
            return hash;
          },
          Effect.mapError((cause) => new MediaError({ operation: "publish", path: root, cause })),
        ),
        path: Effect.fn("BlobStore.path")(
          function* (hash: MediaHash) {
            const dir = path.join(root, hash.slice(0, 2));
            const names = yield* fs.readDirectory(dir);
            const name = names.find((name) => name.startsWith(`${hash}.`));
            if (!name)
              return yield* new MediaError({ operation: "path", path: dir, cause: "Blob missing" });
            return path.join(dir, name);
          },
          Effect.mapError((cause) => new MediaError({ operation: "path", path: root, cause })),
        ),
      };
    }),
  );

export const encodeArgs = [
  "-map",
  "0:v:0",
  "-map",
  "0:a?",
  "-vf",
  "showinfo",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "28",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
] as const;
export const encodeArgsHash = createHash("sha256").update(JSON.stringify(encodeArgs)).digest("hex");

export const clipEncoderLayer = Layer.effect(
  ClipEncoder,
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const process = yield* Process;
    return {
      encode: Effect.fn("ClipEncoder.encode")(function* (
        media: ProbedMedia,
        start: VideoSeconds,
        end: VideoSeconds,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            if (end <= start)
              return yield* new MediaError({
                operation: "encode",
                path: media.path,
                cause: "Empty clip",
              });
            const temp = yield* blobs.tempPath("mp4");
            const source = yield* probeFile(media.path);
            const seekOffset =
              Number(source.streams[0]?.start_time ?? 0) - Number(source.format.start_time ?? 0);
            const encoded = yield* commandCapture("ffmpeg", [
              "-nostdin",
              "-y",
              "-ss",
              String(start + seekOffset),
              "-to",
              String(end + seekOffset),
              "-i",
              media.path,
              ...encodeArgs,
              temp,
            ]);
            const metadata = yield* probeFile(temp);
            const clipStart = yield* Schema.decodeEffect(VideoSeconds)(
              start + Number(encoded.stderr.match(/n:\s*0\s+pts:.*?pts_time:([\d.e+-]+)/)?.[1]),
            ).pipe(
              Effect.mapError(
                (cause) => new MediaError({ operation: "encode", path: temp, cause }),
              ),
            );
            return {
              blob: yield* blobs.publish(temp, "mp4"),
              clipStart,
              durationSec: Number(metadata.format.duration),
            };
          }),
        ).pipe(Effect.provideService(Process, process));
      }),
    };
  }),
);
