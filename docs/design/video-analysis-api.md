# Video analysis API: design

Status: draft for review. Nothing here is implemented yet.

## Goal

Build the system proposed in the paper (`latex/main.tex` §3). A broadcast half goes in. Highlight events come out, each with a class, a timestamp, a confidence and a clip. The stages are TransNetV2 scene cuts, YOLO detections, the pre-LLM rule filter, and a multimodal LLM through OpenRouter.

Requirements from the user:

- Computer vision runs locally on CUDA. Apple Silicon is supported if it's cheap.
- The LLM runs through OpenRouter.
- A robust API and data layer, ready for a web UI later.
- TypeScript and Effect, with as little Python as possible.
- Lint and Effect practices copied from `pingdotgg/t3code`.
- Test calls use free OpenRouter video models. `z-ai/glm-5.3-flash` comes in only near the end. The account holds $1.34.

## Who uses it

- **You, from a CLI**, analysing a SoccerNet half or any local video, and running the evaluations behind the paper.
- **A future web UI**, which submits jobs, follows progress, lists highlights and plays clips. It uses the same generated client the CLI uses.
- **The next maintainer**, who needs each number in the paper to come from one command over stored artifacts.

## What the evidence says

Research notes are in the session scratchpad. They are summarised here, with each line labelled.

- **The paper's LLM numbers measure a different input from the one the system sends** (verified). Benchmark segments were 40 s windows placed around annotated events (30 s before, 10 s after), plus negatives at fixed steps (`~/tcc/benchmark/src/selection.ts:85`). The system sends rule-filter windows instead (10 s before to 16 s after each qualifying scene start, merged). End-to-end F1 is a new measurement, not a reproduction.
- **No existing command recomputes F1@5s from the stored raw responses** (verified). `~/tcc/benchmark/.scratch/openrouter-720p-top3-budget1000.sqlite` stores 3,000 responses and the scores 0.596, 0.521 and 0.392. The current scorer computes mAP. The run index records `code_version: null`, so nobody knows which scorer produced the stored scores.
- **The benchmark stored only the first choice's text plus some metadata** (verified), not the full provider reply.
- **The rule is fully specified, and three golden fixtures exist** (verified). The fixtures were generated with the existing Python, and they hold 36, 35 and 33 windows. In config C, the `zero`, `cluster`, `min_previous` and `drop_fraction` parameters filter nothing. Goalkeepers are not counted as players. Windows are clamped to the end of YOLO coverage, not to the end of the video.
- **The stored dataset fingerprint hashes paths, modification times and sizes, not content** (verified). A reproduction is checked by counts instead: 497 videos, 249 games, 1,360,281.6 s, 4,369 test events and 5,920 test proposals.
- **Free video models** (measured). OpenRouter lists four. Only `nvidia/nemotron-3.5-super-vl:free` advertises `structured_outputs`. One call with a 10 s clip and a strict schema returned valid JSON in 12.0 s and cost $0. The free quota is account-wide: 20 requests per minute, plus 50 or 1,000 per day depending on lifetime purchased credits (cited).
- **Video cost.** Flash-lite recorded $0.001287 per 40 s segment over 1,000 calls (measured). Gemini samples 1 frame per second at about 70 tokens per frame (cited). Nothing documents how GLM 5.3 Flash counts video tokens.
- **CV without Python.** `onnxruntime-node` 1.31.1 lists CUDA 12 on Linux x64 and CoreML on macOS arm64 (cited). The parity and throughput prototype is still running. See [CV runtime](#cv-runtime).
- **t3code** (verified by reading the code). It uses Effect 4.1.3, `@effect/tsgo` diagnostics configured in `tsconfig.effect.json`, oxlint and oxfmt run by Vite+, shared Schema contracts, `Context.Service` services with layers, `Schema.TaggedError`, named `Effect.fn` spans, and `@effect/vitest`. Its SQLite adapter is custom, and its `@effect/vitest` is patched for Vite+.
- **Hardware** (measured). Linux, RTX 3070 Laptop GPU, driver 550. Local data holds 1,100 halves at 224p, 24 at 720p and 500 label files.

## Candidates considered

| | A. Durable jobs with a stage cache | B. Streaming pipeline writing run folders |
|---|---|---|
| Shape | SQLite is the source of truth for media, jobs, stage runs, LLM attempts and highlights. Media goes in a content-addressed blob store. | `POST /analyze` streams progress. Each run writes `manifest.json`, `scenes.json`, `windows.json`, `verdicts.json` and clips into a folder. |
| Resume after a crash | Rerun the job. Finished stages and LLM attempts are found by key and skipped. | Rerun from scratch, or add bespoke checkpoint files. |
| Changing the rule or the model | Recomputes only the stages downstream of the change. | Recomputes everything unless caching is added later. |
| Web UI | Queries, paging, progress and cost per job come straight from tables. | The UI has to scan and parse folders. |
| Audit and budget | Every attempt and its cost is a row. The budget is a query. | A ledger file per run. A global budget needs a scan. |
| Code size | Larger: migrations, repositories, a job runner. | Smaller at first. |

**Choice: A.** A robust data layer and a web UI are exactly what B gives up. B only saves code on day one. The stage cache is what makes iterating on rules and models cheap, and that iteration is the paper's daily work.

Event sourcing, as t3code does it, was rejected. It earns its place in t3code's orchestration with many clients. Here it would add a projection layer over a pipeline that runs in one direction.

## Architecture

```
packages/contracts   Effect Schema: domain types, branded ids, the HttpApi definition, the LLM verdict schema
apps/server          services, persistence, job runner, HTTP server, and the CLI
```

That is the whole layout. A web UI becomes `apps/web` and imports `packages/contracts`.

**There is one writer.** `serve` is the only process that opens the database for writing. It takes an exclusive lock on the data directory, so a second server fails at startup. The CLI is an HTTP client generated from `packages/contracts`, the same client the web UI will use. So the CLI tests the contract on every use. The `eval` commands read study data and the benchmark database, and never touch the app database.

### Pipeline

The stages run in a fixed order. A linear list is enough, so there is no general DAG engine.

| Stage | Input | Output | Runs on |
|---|---|---|---|
| `probe` | media file | duration, fps, size, frame count, sha256 | ffprobe |
| `scenes` | media | scene list (start/end frame and seconds) | TransNetV2, GPU |
| `detections` | media | samples every `stride` frames, with counts per class | YOLO `best.pt`, GPU |
| `windows` | scenes, samples, rule config | merged candidate windows and their anchor scenes | pure TS |
| `segments` | windows | LLM segments of at most 40 s, encoded MP4 | ffmpeg |
| `verdicts` | segments, model, prompt | one LLM attempt record per call, with the parsed verdict | OpenRouter |
| `highlights` | verdicts, windows | events in video time, merged across overlaps, with optional clips | pure TS, ffmpeg |

**Stage keys carry provenance.** A stage run's key is the sha256 of:
- the stage name and code version;
- its input keys;
- its parameters: weight file hashes, preprocessing settings (input size, letterbox, stride, thresholds), the runtime and its version, the prompt and schema hashes, the model id, and inference settings such as `max_tokens` and temperature.

A finished stage run with the same key is reused. `force` on a job creates a new job but still reuses stage runs, because an honest key means a cached result is correct. A wrong cached result is a missing parameter in the key, and the fix is to add it.

**Publication is atomic.** A stage writes its artifact to a temporary path and renames it into the blob store. Only then does it mark the stage run finished, in one transaction with its rows.

**GPU.** `scenes` and `detections` share one GPU semaphore with a single permit. Each decodes the video separately with its own ffmpeg pass. A shared decode would need buffering or coordinated consumers, and is only worth it if measurement shows decode limits throughput.

### Domain model

Ids are branded strings: `MediaHash`, `SourceId`, `JobId`, `StageRunKey`, `SegmentId`, `AttemptId`, `HighlightId`.

Times are branded numbers, one brand per reference frame:
- `VideoSeconds`, time from the start of the media file;
- `ClipSeconds`, time from the start of an encoded segment;
- `FrameIndex`, the decoded frame number.

The type checker rejects mixing them, which is exactly the bug the timestamp mapping invites. A SoccerNet half's video time is the time `Labels-v2.json` uses, so evaluation compares `VideoSeconds` directly. The system does not claim a match clock (minute 37'). That would need aligning each broadcast to kickoff, which no stage measures. Output reports `half` and `videoSeconds`.

```ts
type SourceRef =
  | { _tag: "LocalFile"; path: string }
  | { _tag: "SoccerNetHalf"; league: string; season: string; game: string; half: 1 | 2; resolution: "224p" | "720p" }

type JobState =
  | { _tag: "Queued" }
  | { _tag: "Running"; stage: StageName; done: number; total: number }
  | { _tag: "Succeeded"; coverage: Coverage }
  | { _tag: "Partial"; coverage: Coverage; reason: PartialReason }
  | { _tag: "Failed"; stage: StageName; error: JobError }
  | { _tag: "Cancelled" }

type Coverage = { segments: number; valid: number; invalid: number; ambiguous: number; notSent: number }
type PartialReason = { _tag: "BudgetExceeded"; capUsd: number; committedUsd: number } | { _tag: "AmbiguousAttempts"; count: number }

type JobSpec = {
  rule: RuleConfig              // default: saved config C
  llm: { model: ModelId; promptVersion: string; maxCostUsd: number }
  clips: boolean                // default true
}
```

`Coverage` on the result separates "no highlights" from "the model's outputs were invalid" and from "we stopped early". An empty list alone would hide which one happened.

`RuleConfig` is a tagged union of `Zero` and `Context`, and each variant holds only the parameters its rule reads. Config C currently carries a `drop_fraction` that nothing reads. The union makes that unrepresentable.

The job state is a state machine. Legal transitions live in one function, and nothing writes a status column directly.

A `Partial` or `Failed` job resumes with `POST /jobs/:id/resume`. Resuming re-admits the segments that were never sent, under the current budget. It never resends an ambiguous attempt unless `retryAmbiguous` is set.

### Data layer

SQLite through `@effect/sql-sqlite-node` 4.1.x, with Effect migrations. Tables:

- `media` holds the sha256, size and probe. The hash is media identity.
- `sources` holds a `SourceRef` and the media it resolved to, plus the size and mtime seen at hashing. Before each stage reads the file, it compares size and mtime. If they changed, it rehashes, and a different hash fails the job with `SourceChanged`.
- `jobs` holds the id, source, spec, state and timestamps. Claiming a queued job is one transactional update.
- `stage_runs` holds the key (primary key), stage, version, the parameters as JSON, status, timing, the device actually used (for example `cuda` or `cpu`) and any error.
- `job_stages` links a job to the stage runs it used.
- `scenes` and `samples` are rows keyed by stage run. Samples hold counts per class only. Boxes are not stored in v1.
- `windows` and `segments` are rows keyed by stage run. A segment points to its clip blob and records the clip's real start, from ffprobe on the encoded file.
- `llm_attempts` holds the segment, model, prompt version, attempt number, state (`Reserved`, `Sent`, `Answered`, `Failed`, `Ambiguous`), the reserved amount, HTTP status, the full response JSON, the parsed verdict or parse error, usage, `usage.cost`, the generation id and latency. The full response is kept, which the benchmark didn't do.
- `highlights` holds the job, class, `videoSeconds`, confidence, segment, attempt and clip blob.

Blobs live at `<dataDir>/blobs/sha256/<ab>/<hash>.<ext>`. The default data directory is `$XDG_DATA_HOME/tcc-highlights`.

### Paid calls and the budget

The danger is a request that charges money and then dies before its reply reaches the database. Every attempt is written before it's sent:

1. In one transaction, check admission and insert the attempt as `Reserved` with its reserved amount.
2. Mark it `Sent`, then send the request.
3. On reply, store the full response, set `Answered` or `Failed`, and replace the reservation with `usage.cost`.

At startup, any attempt still `Sent` becomes `Ambiguous`. It keeps its reservation and is never retried automatically, because OpenRouter can't be asked about a call whose generation id we never received. Free-model attempts reserve $0, so retrying them is safe and automatic.

**Admission control, not a hard ceiling.** Before each paid attempt, the runner checks committed spend plus reservations plus the new reservation against two limits:
- the job's `maxCostUsd` (default $0.10; flash-lite at about 36 windows per half is around $0.05, inferred from recorded cost);
- the account limit, `OPENROUTER_BUDGET_USD`.

The reservation is a pessimistic bound: video seconds times the model's highest recorded cost per second, plus the full `max_tokens` priced as output. A model with no record uses a configured bound. If the new attempt would cross a limit, the stage stops and the job becomes `Partial`. Paid concurrency is 1.

A local ledger can't stop spending from other clients or from estimate errors. **The hard ceiling is a dedicated OpenRouter key with its own credit limit** set below the balance, so OpenRouter itself refuses calls past it. OpenRouter refuses video requests when less than $1.00 remains on the key or the account, so the key's limit must sit at least $1.00 above the intended spend, and the last $1.00 of the account can't be spent on video.

### LLM boundary

- The prompt, schema and class list are ported verbatim from `~/tcc/benchmark/src/openRouterEvaluation.ts:649` and `:1037`, and versioned as `benchmark-v1`. Any change is a new prompt version and a new measurement.
- Requests use `response_format: json_schema` with `strict: true` and `provider.require_parameters: true`. A provider that cannot honour the schema is never chosen.
- `parseVerdict` validates locally with Schema. These are invalid verdicts, not crashes: a schema violation, `finish_reason: "length"`, empty content, or a timestamp outside `[0, clip duration]`. The paper reports the valid-output rate, so invalid outputs are data.
- **Retries.**
  - 408, 425, 429 and 5xx retry with backoff, honouring `Retry-After`.
  - 402 is read from its metadata. An in-flight budget limit is transient and is retried later. Exhausted credit ends the job as Partial (`CreditExhausted`): answered verdicts are kept, the rest count as not sent, and the job can be resumed after a top-up. OpenRouter's "requires at least $1.00 in balance for video" reply counts as exhausted credit, whatever its status.
  - 401 and 403 stop the job. A 403 from moderation marks that segment's verdict invalid instead.
- **Rate limits.** One account-wide limiter covers free models: 20 per minute and the daily cap. The daily cap is 50 until you confirm otherwise.

### Timestamp mapping

A segment's clip starts at `clipStart: VideoSeconds`, read from the encoded file, not from the requested cut point. The model returns `t: ClipSeconds`. The result is `clipStart + t`, accepted only when `0 <= t <= clip duration`. Frame-to-seconds conversion reads presentation timestamps, so variable frame rates are handled.

Windows longer than 40 s are split into segments of at most 40 s that overlap by 5 s. Forty seconds is the benchmark's length, but this is an experiment, not an equivalence: the benchmark centred its clips on events and the rule doesn't.

Merging across the overlap:
- Only neighbouring segments are compared, and only predictions inside their shared 5 s.
- Pairs of the same class are matched one to one, nearest first. Ties go to the higher confidence, then to the earlier segment.
- A matched pair becomes one highlight. Unmatched predictions stay as they are.
- Every raw prediction stays in `llm_attempts`, so a merge can always be audited or redone.

The 40 s and 5 s values are tuned on the train split and frozen before any held-out evaluation.

### CV runtime

Both detectors are services. Changing runtimes stays inside one module.

```ts
class SceneDetector extends Context.Service<SceneDetector, {
  readonly detect: (media: ProbedMedia) => Effect.Effect<ReadonlyArray<Scene>, InferenceError>
}>()("highlights/cv/SceneDetector") {}

class ObjectDetector extends Context.Service<ObjectDetector, {
  readonly detect: (media: ProbedMedia, stride: number) => Stream.Stream<Sample, InferenceError>
}>()("highlights/cv/ObjectDetector") {}
```

- **N. ONNX in Node.** Export `best.pt` and TransNetV2 to ONNX once, and run them with `onnxruntime-node` (CUDA on Linux, CoreML on macOS). Frames come from ffmpeg as raw RGB. TypeScript reproduces the preprocessing exactly: Ultralytics' letterbox and NMS for YOLO, and OpenCV's resize and the windowing for TransNet. Python is needed only for the one-time export.
- **P. Python worker.** A persistent process wraps today's `run_transnet` and `run_yolo` and speaks JSON lines over stdin and stdout. It reuses the existing preprocessing, so parity is near certain. But Python, torch and CUDA wheels stay a runtime dependency.

**P ships first, and N replaces it when it passes all of these:**
1. It runs on the CUDA provider. The device is read from the session, not assumed.
2. On at least five halves at both resolutions, the TypeScript rule over N's output gives exactly the same windows as over P's.
3. At least 99% of scene cuts land within ±1 frame.
4. Memory stays bounded over a full half.
5. Cancelling mid-stage kills the ffmpeg process and frees the GPU.

Criterion 2 measures what matters: the input the LLM receives.

Prototype results so far (from the session scratchpad):
- **Python reference on CUDA works** (measured). On a 60 s 224p clip it found 3 scenes and 300 samples.
- **Both models export to ONNX and run in Node on the CPU** (measured), on synthetic input. YOLO exports at opset 17 with a dynamic batch. Its output is `(N, 8, 8400)` with NMS outside the graph, so the TypeScript side has to implement NMS.
- **Node on CUDA fails on this machine** (measured). `onnxruntime-node` 1.31.1's CUDA provider loads `libcublasLt.so.13`, a CUDA 13 library. The driver here is 550, which supports CUDA up to 12.4 (measured with `nvidia-smi`). Two ways forward, neither tried: upgrade the driver to a CUDA 13-capable release (inferred to be 580 or later), or pin an older `onnxruntime-node` built for CUDA 12. Either is a single experiment inside V4.
- **Not measured yet:** parity on real video and throughput.

This supports shipping P first. N stays a measured upgrade, gated by V4.

Apple Silicon waits until Linux works. The service boundary keeps that a local change, and v1 maintains one runtime, not two. `CV_DEVICE=auto|cuda|cpu` selects the device, and the stage run records the one actually used, so a CPU fallback is never silent.

### HTTP API

Built with Effect HttpApi from `packages/contracts`. It listens on `127.0.0.1` with no auth.

| Method | Path | Purpose |
|---|---|---|
| POST | `/sources` | Register a `SourceRef`. Probes and hashes it. Invalid paths, missing files and unprobeable media return 400 `BadRequest`. Idempotent by canonical source reference; media is shared by hash. |
| GET | `/sources/:id` | Source, media and probe. |
| POST | `/jobs` | `{ sourceId, spec? }` returns 202 and the job. The same source and spec return the existing job unless `force` is set. |
| GET | `/jobs` | Paged list, filterable by state. `offset >= 0`, `1 <= limit <= 100`; invalid bounds return 400 `BadRequest`. |
| GET | `/jobs/:id` | State, per-stage progress, devices used, coverage, cost committed and reserved. |
| POST | `/jobs/:id/cancel` | Cancel. Finished stage runs stay for reuse. |
| POST | `/jobs/:id/resume` | Resume a `Partial` or `Failed` job. Optional `retryAmbiguous` authorizes only currently Ambiguous attempts and is cleared on recovery or verdict completion. |
| GET | `/jobs/:id/result` | Paper §3.5 output: highlights with class, half, `videoSeconds`, confidence, id and clip URL, plus coverage. |
| GET | `/blobs/:hash` | Clips as `video/mp4` and JSON artifacts as `application/json`, with HTTP Range support. |
| GET | `/budget` | Limit, committed, reserved, ambiguous. |

Progress comes from polling `GET /jobs/:id`. Deferred until a consumer needs them: server-sent events, audit views of scenes, windows and attempts, detection boxes, and a model registry endpoint. Each is an additive change to the contract. Boxes are the only one with a real later cost, because adding them means rerunning `detections`.

CLI: `serve`, `analyze <path | soccernet id>`, `jobs`, `result <id>`, `budget`, and the `eval` commands below.

### Job runner

One runner fiber in the server claims queued jobs transactionally. At startup, jobs left `Running` go back to `Queued`, and attempts left `Sent` become `Ambiguous`. A requeued job skips finished stage runs and answered attempts by key. Cancelling interrupts the job's fiber. The ffmpeg and inference subprocesses are scoped resources, so they're killed with it.

## Verification

Each check is a command, and its output is the evidence. None needs your judgment to pass.

| # | Check | Pass condition | Cost |
|---|---|---|---|
| V1 | Rule port against the three Python fixtures | Identical windows, within 1 ms | $0 |
| V2 | Rule port over the full study | 497 videos, 249 games, 1,360,281.6 s, test recall 3980/4369, reduction 0.32214, 5,920 proposals | $0 |
| V3a | Ported parser and F1@5s scorer against the benchmark's current TS scorer on the same stored predictions | Identical per-segment matches | $0 |
| V3b | Rescore the 3,000 stored raw responses | Reported next to 0.596, 0.521 and 0.392. Not a gate, because the historical scorer's version is unknown. A mismatch is a finding about the paper. | $0 |
| V4 | CV runtime N against P | The five criteria under [CV runtime](#cv-runtime) | $0 |
| V5 | Failure injection: kill the server between `Sent` and reply, between artifact write and commit, and during cancel. Change the source file between stages. | `Ambiguous` with its reservation kept. No half-published artifact. Subprocesses gone. `SourceChanged`. | $0 |
| V6 | Timestamp fixtures: a second half, a clip whose real start differs from the requested cut, a variable-frame-rate file | Event times land within one frame of the expected value. Re-encoding is lossy, so clips are compared by frame timestamp, not pixels. | $0 |
| V7 | Recorded OpenRouter replies: 429, in-flight 402, credit 402, 5xx, `length`, schema violation, moderation 403 | Each maps to its specified state | $0 |
| V8 | Smoke run on the free model, end to end | A job reaches `Succeeded` and its result validates against the contract. If the provider is down, it's reported as an outage, not a failure. | $0 |
| V9 | Tune segment length and overlap on train halves with the free model, then freeze them | Frozen values committed with their measurements | $0 |
| V10 | One GLM 5.3 Flash call | One observed cost per video second. This seeds the reservation bound but isn't a cost model. | about $0.001 (guess) |
| V11 | GLM against flash-lite's stored answers on about 100 benchmark segments, every class plus negatives | F1@5s and valid rate on the same segments, with a paired bootstrap interval | a few cents (inferred) |
| V12 | End to end on held-out halves, scored against Labels-v2 | First system-level F1@5s and cost per half | about $0.05 per half on flash-lite (inferred) |

V2 reads the study's xlsx files through the existing Python reader, exported once to JSON. That's offline reproduction, not the shipped API, so porting xlsx parsing to TypeScript would add code without making the system any less dependent on Python.

Spending order: V1 to V9 cost nothing. V10 to V12 together stay under $0.50, which leaves most of the $1.34.

### Results

Paid runs went through a dedicated key and the ledger. Total spend was $0.61, with no double-billed call. Reports are in `docs/design/results/`.

- **V10.** GLM 5.3 Flash made 9 calls on a 7-minute clip for $0.0072, about $0.0008 per 40 s segment, at 17 to 99 s per call. 3 of the 9 answers were cut off: GLM spent all 4,096 output tokens reasoning.
- **V11.** On the same 100 benchmark segments, GLM scored F1@5s 0.313 and flash-lite 0.555. The paired bootstrap gives ΔF1 −0.242, with a 95% interval of [−0.330, −0.157].
  - GLM gave a valid answer on 57%: 42 were truncated and 1 timed out. The timed-out call stayed ambiguous and was not resent.
  - On the 57 segments GLM did answer, it scored 0.447 against flash-lite's 0.579.
  - flash-lite is about 11 times faster (6 s per call against 62 s). So flash-lite is the model for the remaining paid checks, and GLM was dropped.
- **V9.** This deviated from the plan: the free model's answers are noise (F1 about 0.06 on 3 train halves), so tuning ran on flash-lite, on 2 train halves.
  - 40/5 scored F1 0.349 (P 0.23, R 0.69) at $0.067 per half.
  - 20/4 scored F1 0.242 (P 0.15, R 0.72) at $0.085 per half, and was worse on both halves.
  - **Frozen at 40 s segments with 5 s overlap.** Two halves are too few for a reliable interval, but the direction agreed on both.
- **V12.** Three test halves at 40/5 with flash-lite gave a pooled F1@5s of **0.389** (P 0.295, R 0.571; TP 44, FP 105, FN 33).
  - The rule's recall ceiling was 68 of 77 labels (0.88).
  - Cost was $0.071 per half, 190 of 191 answers were valid, and none were ambiguous.
  - Per half, F1 was 0.30, 0.39 and 0.48.
  - Precision is the weak point. "Shot on target" alone produced 58 of the 105 false positives, while Goal recall was 5 of 5.
  - Three halves show the system works end to end. They are not enough for a citable system score.
- **Spending floor.** OpenRouter refuses video requests below $1.00 of balance. A capped key needs its limit at least $1.00 above the intended spend.

## Tooling

- pnpm workspace on Node 26, the version t3code pins.
- Effect 4.1.3 and `@effect/*` 4.1.x.
- `@effect/tsgo` typechecks, using `tsconfig.base.json` and `tsconfig.effect.json` copied from t3code.
- oxlint and oxfmt run directly, with the rule categories and overrides from t3code's `vite.config.ts`. Rules that need t3code's own plugin, shadcn or React are left out.
- Plain Vitest with `@effect/vitest`, without the Vite+ patch. Test layers fake ffmpeg, OpenRouter and the file system. Domain logic is tested through its service, never by mocking it.
- `AGENTS.md` carries t3code's Effect rules: `Effect.fn` with stable span names, `Schema.TaggedError` with structured fields, `runPromise` only at the edges, and no `sleep` polling in tests.

The first implementation step is a scaffold that proves the versions work together before anything else is written: one migration on `@effect/sql-sqlite-node`, one subprocess cancelled mid-run, and one HttpApi endpoint called from the generated client.

## What stays in Python

- The existing study and dashboards in `src/tcc_soccer_highlights`. They back the paper as it stands.
- The inference worker (option P) until option N passes V4. After that, only a one-time ONNX export script.
- A one-time export of the study's xlsx inputs to JSON for V2.

## Open decisions

1. **Where the code lives.** My recommendation is this repo, as a pnpm workspace next to the Python study, so the paper, the rule study and the system share one history. The alternatives are `~/tcc`, next to the benchmark, or a new repo.
2. **The free-tier daily limit.** Resolved: lifetime credits are over $10, so the cap is 1,000 a day.
3. **A dedicated OpenRouter key with a credit limit.** Resolved: a key capped at $2.00, with the server budget holding total spend to the $0.90 approved.
4. **NVIDIA driver.** Upgrading from 550 to a driver that supports CUDA 13 is the simplest way to let ONNX run on the GPU from Node. It's a system change on your machine. Without it, option N needs an older `onnxruntime-node` built for CUDA 12.
5. **Replays.** v1 keeps the benchmark's categories, which have no replay type, so results stay comparable with the paper. A replay field would be a new prompt version, measured on its own.
