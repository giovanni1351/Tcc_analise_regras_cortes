import { predictionSchema, targetEventClasses } from "@tcc/contracts";

export const promptVersion = "benchmark-v1";
export const systemPrompt =
  "You detect soccer highlight events in one clipped video segment. Return exactly one top-level JSON object matching the requested schema. Never wrap the object in an array and never repeat the schema.";
export const userPrompt = [
  `Allowed event classes: ${targetEventClasses.join(", ")}.`,
  "Use timestamp_seconds relative to the start of this video segment.",
  "If there are no allowed events, return segment_kind Non-highlight and an empty events array.",
  "If there is one allowed event, return segment_kind Single-highlight.",
  "If there are multiple allowed events, return segment_kind Multi-highlight.",
].join("\n");

export const requestBody = (model: string, videoDataUrl: string, maxTokens: number) => ({
  model,
  max_tokens: maxTokens,
  response_format: {
    type: "json_schema",
    json_schema: { name: "soccernet_segment_prediction", strict: true, schema: predictionSchema },
  },
  provider: { require_parameters: true },
  usage: { include: true },
  messages: [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt },
        { type: "video_url", video_url: { url: videoDataUrl } },
      ],
    },
  ],
});
