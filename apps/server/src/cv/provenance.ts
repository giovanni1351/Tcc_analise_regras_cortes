import { Effect, FileSystem } from "effect";

export const cvParams = { threshold: 0.5, stride: 5, conf: 0.25, iou: 0.45, batch: 16 };
export const cvProvenance = Effect.fn("CV.provenance")(function* (root = ".") {
  const fs = yield* FileSystem.FileSystem;
  const model = yield* fs.readFile(`${root}/best.pt`);
  const worker = yield* fs.readFile(`${root}/workers/cv/worker.py`);
  const reference = yield* fs.readFile(`${root}/src/tcc_soccer_highlights/batch_analysis.py`);
  const hash = (bytes: Uint8Array) =>
    Effect.promise(async () => {
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    });
  const source = new Uint8Array(worker.length + reference.length);
  source.set(worker);
  source.set(reference, worker.length);
  return { modelSha256: yield* hash(model), workerSha256: yield* hash(source) };
});
