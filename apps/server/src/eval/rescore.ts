import type { ModelPrediction } from "./rescore-parser.ts";
export interface Truth {
  readonly id: string;
  readonly targetClass: string | null;
  readonly seconds: number;
  readonly visibility: string;
}
export function matchAt5(
  predictions: ReadonlyArray<ModelPrediction>,
  truth: ReadonlyArray<Truth>,
  startSeconds: number,
  includeNotShown: boolean,
) {
  const groundTruth = truth.filter(
    (event) => event.targetClass !== null && (includeNotShown || event.visibility !== "not shown"),
  );
  const matched = new Set<string>();
  const matches = [...predictions]
    .sort((a, b) => b.confidence - a.confidence)
    .map((prediction) => {
      const nearest = groundTruth
        .filter(
          (event) =>
            !matched.has(event.id) &&
            event.targetClass === prediction.targetClass &&
            Math.abs(event.seconds - startSeconds - prediction.timestampSeconds) <= 5,
        )
        .sort(
          (a, b) =>
            Math.abs(a.seconds - startSeconds - prediction.timestampSeconds) -
            Math.abs(b.seconds - startSeconds - prediction.timestampSeconds),
        )[0];
      if (nearest) matched.add(nearest.id);
      return { predictionId: prediction.id, truthId: nearest?.id ?? null };
    });
  return {
    matches,
    tp: matched.size,
    fp: predictions.length - matched.size,
    fn: groundTruth.length - matched.size,
  };
}
