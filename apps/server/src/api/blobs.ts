import { Effect, FileSystem } from "effect";
import { HttpServerResponse } from "effect/http";
import { NotFound, type MediaHash } from "@tcc/contracts";
import { BlobStore } from "../services.ts";
import { persistence } from "../jobs/repository.ts";

export const byteRange = (header: string, size: number): { start: number; end: number } | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < size &&
    end >= start
    ? { start, end }
    : null;
};
export const getBlob = Effect.fn("Blobs.get")(function* (hash: MediaHash, range?: string) {
  const blobs = yield* BlobStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* blobs
    .path(hash)
    .pipe(Effect.mapError(() => new NotFound({ resource: "blob", id: hash })));
  const info = yield* fs
    .stat(path)
    .pipe(Effect.mapError(() => new NotFound({ resource: "blob", id: hash })));
  const size = Number(info.size);
  const selected = range === undefined ? undefined : byteRange(range, size);
  if (selected === null)
    return HttpServerResponse.empty({
      status: 416,
      headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
    });
  return yield* HttpServerResponse.file(path, {
    status: selected ? 206 : 200,
    ...(selected ? { offset: selected.start, bytesToRead: selected.end - selected.start + 1 } : {}),
    headers: {
      "accept-ranges": "bytes",
      ...(selected ? { "content-range": `bytes ${selected.start}-${selected.end}/${size}` } : {}),
    },
  }).pipe(persistence("readBlob"));
});
