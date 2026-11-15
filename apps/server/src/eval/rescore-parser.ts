import { targetEventClasses } from "@tcc/contracts";
type TargetEventClass = (typeof targetEventClasses)[number];
type SegmentKind = "Single-highlight" | "Multi-highlight" | "Non-highlight";
export type PredictionValidationError =
  | "invalid-json"
  | "invalid-shape"
  | "invalid-segment-kind"
  | "invalid-event-class"
  | "invalid-timestamp"
  | "invalid-confidence";

export type ModelPrediction = {
  id: string;
  segmentId: string;
  targetClass: TargetEventClass;
  timestampSeconds: number;
  confidence: number;
  alternatePrediction: ModelPredictionAlternate | null;
};

export type ModelPredictionAlternate = {
  targetClass: TargetEventClass;
  timestampSeconds: number;
  confidence: number;
};

export type ParsedSegmentPrediction = {
  segmentId: string;
  segmentKind: SegmentKind;
  predictions: ModelPrediction[];
};

export type InvalidSegmentPrediction = {
  segmentId: string;
  error: PredictionValidationError;
  message: string;
};

export function parseStructuredPrediction(input: {
  segmentId: string;
  responseText: string;
}): { ok: true; value: ParsedSegmentPrediction } | { ok: false; error: InvalidSegmentPrediction } {
  let value: unknown;
  try {
    value = JSON.parse(input.responseText);
  } catch {
    return invalid(input.segmentId, "invalid-json", "Response is not valid JSON.");
  }

  if (!isRecord(value)) {
    return invalid(input.segmentId, "invalid-shape", "Response must be a JSON object.");
  }

  const segmentKind = value.segment_kind;
  if (!isSegmentKind(segmentKind)) {
    return invalid(
      input.segmentId,
      "invalid-segment-kind",
      "segment_kind must be a valid Segment Kind.",
    );
  }

  if (!Array.isArray(value.events)) {
    return invalid(input.segmentId, "invalid-shape", "events must be an array.");
  }

  const predictedKind = segmentKindForEventCount(value.events.length);
  if (segmentKind !== predictedKind) {
    return invalid(
      input.segmentId,
      "invalid-segment-kind",
      `segment_kind ${segmentKind} does not match ${value.events.length} event predictions.`,
    );
  }

  const predictions: ModelPrediction[] = [];
  for (const [index, event] of value.events.entries()) {
    if (!isRecord(event)) {
      return invalid(input.segmentId, "invalid-shape", "Each event must be an object.");
    }
    const targetClass = event.event_class;
    if (!isTargetEventClass(targetClass)) {
      return invalid(
        input.segmentId,
        "invalid-event-class",
        "event_class must be in the Target Event Set.",
      );
    }
    const timestampSeconds = event.timestamp_seconds;
    if (!isNonNegativeFiniteNumber(timestampSeconds)) {
      return invalid(
        input.segmentId,
        "invalid-timestamp",
        "timestamp_seconds must be a non-negative number.",
      );
    }
    const confidence = event.confidence;
    if (!isConfidence(confidence)) {
      return invalid(
        input.segmentId,
        "invalid-confidence",
        "confidence must be a number between 0 and 1.",
      );
    }

    const alternatePrediction = parseAlternatePrediction(input.segmentId, event);
    if (!alternatePrediction.ok) return alternatePrediction;

    predictions.push({
      id: [
        "parsed-prediction",
        input.segmentId,
        String(index),
        targetClass,
        String(timestampSeconds),
      ].join("|"),
      segmentId: input.segmentId,
      targetClass,
      timestampSeconds,
      confidence,
      alternatePrediction: alternatePrediction.value,
    });
  }

  return {
    ok: true,
    value: {
      segmentId: input.segmentId,
      segmentKind,
      predictions,
    },
  };
}

function parseAlternatePrediction(
  segmentId: string,
  event: Record<string, unknown>,
):
  | { ok: true; value: ModelPredictionAlternate | null }
  | { ok: false; error: InvalidSegmentPrediction } {
  const alternate = event.alternate_prediction;
  if (alternate === undefined || alternate === null) return { ok: true, value: null };
  if (!isRecord(alternate)) {
    return invalid(
      segmentId,
      "invalid-shape",
      "alternate_prediction must be an object when provided.",
    );
  }
  const targetClass = alternate.event_class;
  if (!isTargetEventClass(targetClass)) {
    return invalid(
      segmentId,
      "invalid-event-class",
      "alternate_prediction.event_class must be in the Target Event Set.",
    );
  }
  const timestampSeconds = alternate.timestamp_seconds;
  if (!isNonNegativeFiniteNumber(timestampSeconds)) {
    return invalid(
      segmentId,
      "invalid-timestamp",
      "alternate_prediction.timestamp_seconds must be a non-negative number.",
    );
  }
  const confidence = alternate.confidence;
  if (!isConfidence(confidence)) {
    return invalid(
      segmentId,
      "invalid-confidence",
      "alternate_prediction.confidence must be a number between 0 and 1.",
    );
  }
  return {
    ok: true,
    value: {
      targetClass,
      timestampSeconds,
      confidence,
    },
  };
}

function invalid(
  segmentId: string,
  error: PredictionValidationError,
  message: string,
): { ok: false; error: InvalidSegmentPrediction } {
  return {
    ok: false,
    error: {
      segmentId,
      error,
      message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSegmentKind(value: unknown): value is SegmentKind {
  return value === "Single-highlight" || value === "Multi-highlight" || value === "Non-highlight";
}

function isTargetEventClass(value: unknown): value is TargetEventClass {
  return targetEventClasses.some((candidate) => candidate === value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function segmentKindForEventCount(count: number): SegmentKind {
  return count === 0 ? "Non-highlight" : count === 1 ? "Single-highlight" : "Multi-highlight";
}
