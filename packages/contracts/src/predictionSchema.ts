export const targetEventClasses = [
  "Goal",
  "Shot on target",
  "Shot off target",
  "Foul",
  "Offside",
] as const;

export const predictionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["segment_kind", "events"],
  properties: {
    segment_kind: {
      type: "string",
      enum: ["Single-highlight", "Multi-highlight", "Non-highlight"],
    },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_class", "timestamp_seconds", "confidence", "alternate_prediction"],
        properties: {
          event_class: {
            type: "string",
            enum: targetEventClasses,
          },
          timestamp_seconds: {
            type: "number",
            minimum: 0,
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          alternate_prediction: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["event_class", "timestamp_seconds", "confidence"],
                properties: {
                  event_class: {
                    type: "string",
                    enum: targetEventClasses,
                  },
                  timestamp_seconds: {
                    type: "number",
                    minimum: 0,
                  },
                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
} satisfies Record<string, unknown>;
