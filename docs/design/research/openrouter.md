# OpenRouter video research

Snapshot: 2026-11-14. Labels distinguish live observations, cited documentation, and conclusions. Catalog and provider availability can change.

## Free video catalog

**Measured:** GET https://openrouter.ai/api/v1/models, filtering architecture.input_modalities for video, model ID for `:free`, and prompt and completion prices for zero. Provider is the currently listed inference endpoint, checked via `/api/v1/models/{id}/endpoints`. All four have zero prompt and completion prices.

| Model | Context | Provider | Full supported_parameters |
|---|---:|---|---|
| nvidia/nemotron-3.5-super-vl:free | 1,000,000 | Nvidia | include_reasoning, max_tokens, reasoning, response_format, seed, structured_outputs, temperature, tool_choice, tools, top_p |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | 256,000 | Nvidia | include_reasoning, max_tokens, reasoning, seed, temperature, tool_choice, tools, top_p |
| google/gemma-4-26b-a4b-it:free | 262,144 | Google AI Studio | include_reasoning, max_tokens, reasoning, response_format, seed, temperature, tool_choice, tools, top_p |
| google/gemma-4-31b-it:free | 262,144 | Google AI Studio | include_reasoning, max_tokens, reasoning, response_format, seed, temperature, tool_choice, tools, top_p |

**Inferred:** Only the first advertises both response_format and structured_outputs. The Gemma entries advertise response_format but not structured_outputs, which does not establish strict schema support. Model authors are NVIDIA and Google respectively; inference providers are listed separately above.

## Request, limits and billing

**Cited:** Chat Completions uses a content part `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}`. Local/private files use base64 data URLs. Remote URLs are supported only where the selected provider supports them: Google AI Studio supports YouTube links, Vertex AI does not support remote video URLs. Formats listed are MP4, MPEG, MOV and WebM. The guide gives no universal numeric file-size or duration limit and says to check model-specific limits. [Video inputs](https://openrouter.ai/docs/guides/overview/multimodal/videos). Google specifies up to 3 hours at low resolution or 1 hour at high for 1M-context models; this is a Gemini API constraint, not a verified OpenRouter upload limit. [Google video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

**Cited:** Use `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}` and `provider: {require_parameters: true}`. Routing then requires support for the parameters in the request. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

**Cited:** Free variants have an account-wide 20 requests/minute limit, and 50/day until the account has purchased enough credits; the higher limit is 1,000/day after $10 purchased, with a $9 threshold to account for fees. Current balance is not lifetime purchased credits, so $1.34 alone cannot determine the daily limit. [Free models](https://openrouter.ai/collections/free-models), [limits](https://openrouter.ai/docs/api/reference/limits). **Inferred:** inspect `GET /api/v1/key` or purchase history to identify the actual tier.

**Cited:** Request `usage: {include: true}` for token counts and `usage.cost` in the response. Save the generation ID and query authenticated `GET /api/v1/generation?id=...` for `data.total_cost`, provider, native token counts and upstream costs. [Usage](https://openrouter.ai/blog/announcements/smarter-charts-inline-svgs-and-live-usage-accounting/), [generation endpoint](https://openrouter.ai/docs/api/api-reference/generations/get-generation). Do not infer billed cost from a catalog estimate when actual usage is available.

## Video tokens

**Cited:** Gemini 3.1 Flash Lite has a default 70 tokens per video frame. Gemini static processing samples one frame per second by default, adding audio and timestamp/metadata tokens. Gemini 3 media resolution documentation says 70 tokens/frame for default/low/medium and 280 for high; audio is 25 tokens/second. Google’s video guide gives a different generic approximation, 66 or 258 tokens/frame plus 32 audio tokens/second and metadata. These are provider documentation estimates, not an OpenRouter measurement. [Model specification](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite), [resolution](https://ai.google.dev/gemini-api/docs/media-resolution), [video processing](https://ai.google.dev/gemini-api/docs/video-understanding).

**Inferred:** At the default frame rate, soccer events faster than one second may be missed. Test the chosen provider and routing path, including audio and resolution, rather than using a single universal tokens-per-second estimate.

**Measured:** OpenRouter catalog lists `z-ai/glm-5.3-flash` as accepting video and multiple endpoints, with different supported parameters. **Inferred:** No authoritative model/provider-specific per-frame token formula or sampling rate was established for GLM 5.3 Flash. Do not apply the Gemini formula to it. Query usage for the specific provider. [GLM endpoints](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints).

## Live free-model check

**Measured:** One live call, `nvidia/nemotron-3.5-super-vl:free`, Nvidia provider, no other model calls. Input was first 10 seconds of `/home/pedro/tcc/benchmark/videos/gemini38-source-gap-v3/t008-h1-s70-720p.mp4`, ffmpeg H.264 MP4, width 320, no audio, 357 KiB. Sent a base64 data URL and a strict object schema with one required string `description`, no additional properties, plus `provider.require_parameters: true`. HTTP 200, 12.01 seconds elapsed, finish reason `stop`. Content parsed as JSON and matched that schema: `{"description":"A soccer player scores a penalty kick. Afterwards, players from opposing teams are seen talking near each other."}`. The description's factual accuracy was not independently checked.

**Measured:** Usage: `prompt_tokens: 2542`, `completion_tokens: 463`, `total_tokens: 3005`, `cost: 0`, `is_byok: false`, `prompt_tokens_details: {cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0}`, `completion_tokens_details: {reasoning_tokens: 434, image_tokens: 0, audio_tokens: 0}`, `cost_details: {upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0}`. Generation ID `gen-1794703731-pXzJEVp0seo3wul7fyyx`. **Inferred:** The zero video_tokens detail does not mean the video consumed zero prompt tokens. One successful request proves compatibility for this particular input and schema, not reliable performance or quality.

## Failure modes

**Cited:** Pre-response errors typically use `{"error":{"code":429,"message":"...","metadata":{...}}}`. Free-tier and provider 429s can be distinguished through `metadata.limit_source`; use `Retry-After` or rate-limit reset headers when present, with bounded backoff. Upstream capacity 429s may lack reset information. 402 may instead mean credits or in-flight budget. [Limits](https://openrouter.ai/docs/api/reference/limits), [rate limit guide](https://openrouter.ai/blog/llm-api-rate-limits/).

**Cited:** Provider failures can expose `error.metadata` containing provider information and raw details; 502 and 503 can occur. Once streaming starts HTTP can remain 200 and the error appears in a later SSE event with `error` and `choices[0].finish_reason: "error"`. [Errors](https://openrouter.ai/docs/api/reference/errors-and-debugging).

**Inferred:** Reject and classify `finish_reason: "length"`, missing content, invalid JSON and schema violations as incomplete/invalid results even on HTTP 200. Retry only with an appropriate larger output budget and a bounded policy; reasoning tokens may consume that budget, as this test shows.

**Cited:** Input moderation can return HTTP 403 with `error.metadata.reasons`, `flagged_input`, `provider_name`, and `model_slug`. Guardrails and budgets may also return 403, so distinguish metadata and messages. Output refusal or content filtering may instead appear in the completion. [Errors and moderation](https://openrouter.ai/docs/api/reference/errors-and-debugging), [guardrails](https://openrouter.ai/docs/guides/features/guardrails/overview). **Inferred:** Treat flagged text and raw provider errors as potentially sensitive when logging.
