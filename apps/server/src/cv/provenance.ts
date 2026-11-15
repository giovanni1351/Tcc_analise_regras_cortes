import { Effect, FileSystem } from "effect";

import { commandOutput } from "../media/index.ts";

export const cvParams = { threshold: 0.5, stride: 5, conf: 0.25, iou: 0.45, batch: 16 };
export const cvProvenance = Effect.fn("CV.provenance")(function* (
  root = ".",
  transnetWeights?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const weightsPath =
    transnetWeights ??
    (yield* commandOutput("uv", [
      "run",
      "--project",
      root,
      "--no-sync",
      "python",
      "-c",
      "import importlib.util; from pathlib import Path; print(Path(importlib.util.find_spec('transnetv2_pytorch').origin).parent / 'transnetv2-pytorch-weights.pth')",
    ])).trim();
  const transnet = yield* fs.readFile(weightsPath);
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
  return {
    transnetSha256: yield* hash(transnet),
    modelSha256: yield* hash(model),
    workerSha256: yield* hash(source),
  };
});

export const cvStageParams = (
  stage: "scenes" | "detections",
  provenance: Effect.Success<ReturnType<typeof cvProvenance>>,
) =>
  stage === "scenes"
    ? {
        threshold: cvParams.threshold,
        transnetSha256: provenance.transnetSha256,
        workerSha256: provenance.workerSha256,
      }
    : {
        stride: cvParams.stride,
        conf: cvParams.conf,
        iou: cvParams.iou,
        batch: cvParams.batch,
        modelSha256: provenance.modelSha256,
        workerSha256: provenance.workerSha256,
      };
