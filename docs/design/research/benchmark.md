# Benchmark research

All paths below are relative to `/home/pedro/tcc/benchmark` unless absolute. Verified by source inspection and read-only SQLite queries. Inferences are labelled. No network calls were made. Throughput checkpoint: n/a, read-only investigation.

## Components Found

### Module map

The public barrel `src/index.ts:1` exports run, runner, domain, evaluator, provider, SoccerNet, selection and store, but not results/UI. Sizes count lines. Public declarations include exported types and classes. Exported async functions are included.

- `src/benchmarkRun.test.ts` (62 lines). tests for benchmarkRun. Exports: none declared.
- `src/benchmarkRun.ts` (134 lines). run creation and validation. Exports: BenchmarkRunConfigError, defaultScoringFilters, defaultBenchmarkExecutionSettings, createBenchmarkRun, normalizeExecutionSettings.
- `src/benchmarkRunner.test.ts` (92 lines). tests for benchmarkRunner. Exports: none declared.
- `src/benchmarkRunner.ts` (509 lines). grid scheduling and concurrency. Exports: SectionKey, PreparedSegment, ProviderAttempt, BenchmarkGridOutcome, BenchmarkGridRunnerInput, runBenchmarkGrid, ProviderAttemptTimeoutError.
- `src/cli.ts` (697 lines). command-line entry. Exports: none declared.
- `src/domain.ts` (280 lines). domain types and constants. Exports: targetEventClasses, TargetEventClass, EventVisibility, SegmentKind, HighlightEvent, MatchHalf, Match, SegmentContextSpan, AnchorEvent, VideoSegment, SegmentSelectionConfig, SegmentSelection, BenchmarkRunStatus, ProgressMode, BenchmarkExecutionSettings, ScoringFilters, ModelRunConfiguration, BenchmarkRun, ModelEvaluationStatus, ModelEvaluationSectionStatus, SectionFailureStage, ModelEvaluationSection, BenchmarkProgressEvent, RawModelResponseStatus, SectionCostSource, PredictionValidationError, ModelPrediction, ModelPredictionAlternate, ParsedSegmentPrediction, InvalidSegmentPrediction, RawModelResponse, ScoringWindowResult, ModelEvaluation.
- `src/index.ts` (8 lines). public barrel. Exports: none declared.
- `src/migrations.ts` (419 lines). schema migrations. Exports: runMigrations.
- `src/modelEvaluation.test.ts` (346 lines). tests for modelEvaluation. Exports: none declared.
- `src/modelEvaluation.ts` (694 lines). prediction parsing and scoring. Exports: ModelEvaluationError, DryRunEvaluationResult, ModelEvaluationSummary, ClassScoringResult, evaluationWindows, evaluateFakeModel, evaluateFakeModels, summarizeModelEvaluation, parseStructuredPrediction, scoreModelEvaluation, scoreModelEvaluationByClass, median.
- `src/openRouterEvaluation.test.ts` (438 lines). tests for openRouterEvaluation. Exports: none declared.
- `src/openRouterEvaluation.ts` (1100 lines). provider calls and video preparation. Exports: OpenRouterEvaluationError, OpenRouterModelInfo, OpenRouterChatCompletion, OpenRouterHttpClient, OpenRouterModelEligibility, VideoSegmentPreparer, OpenRouterEvaluationResult, OpenRouterSegmentEvaluationResult, OpenRouterEvaluationPersistence, OpenRouterChatCompletionRequest, openRouterReasoningEfforts, OpenRouterReasoningEffort, defaultOpenRouterMaxTokens, evaluateOpenRouterModel, evaluateOpenRouterModels, OpenRouterHttpError, makeOpenRouterHttpClient, buildOpenRouterRequest, validateModelEligibility, selectFreeEligibleModel, isFreeModel, prepareMp4VideoSegment.
- `src/prepareHistory.ts` (40 lines). prepare migrated copy for UI. Exports: none declared.
- `src/readOnlyStore.test.ts` (42 lines). tests for readOnlyStore. Exports: none declared.
- `src/results.test.ts` (262 lines). tests for results. Exports: none declared.
- `src/results.ts` (1072 lines). read models and rescore. Exports: ResultsReadError, BenchmarkRunListItem, SegmentReviewModelResult, SegmentReview, BenchmarkRunDetail, AggregateModelResult, AggregateResults, SegmentInspectionTarget, listBenchmarkRuns, getBenchmarkRunDetail, getAggregateResults, resolveSegmentInspectionTarget.
- `src/selection.test.ts` (129 lines). tests for selection. Exports: none declared.
- `src/selection.ts` (288 lines). deterministic segment selection. Exports: createSegmentSelection, SelectionConfigError, classifySegmentKind.
- `src/soccernet.test.ts` (20 lines). tests for soccernet. Exports: none declared.
- `src/soccernet.ts` (227 lines). dataset discovery and labels. Exports: CatalogError, discoverSoccerNetCatalog, normalizeTargetEventClass, parseGameTime, stableId.
- `src/store.test.ts` (595 lines). tests for store. Exports: none declared.
- `src/store.ts` (728 lines). SQLite persistence. Exports: PersistedModelEvaluationResult, StoreFileError, makeBenchmarkSqliteLayer, makeReadOnlyBenchmarkSqliteLayer, saveSegmentSelectionToSqlite, saveBenchmarkRunToSqlite, saveDryRunEvaluationToSqlite, saveModelEvaluationToSqlite, saveModelEvaluationHeaderToSqlite, saveModelEvaluationSegmentToSqlite, saveModelEvaluationScoringToSqlite, initializeModelEvaluationSectionsToSqlite, saveBenchmarkRunStatusToSqlite, saveModelEvaluationSectionStateToSqlite, exportSegmentSelectionJson.
- `src/ui.ts` (54 lines). UI entry. Exports: none declared.
- `src/uiServer.ts` (221 lines). HTTP UI server. Exports: UiServerOptions, startUiServer.
- `src/videoInspection.test.ts` (55 lines). tests for videoInspection. Exports: none declared.
- `src/videoInspection.ts` (182 lines). external video player launch. Exports: VideoInspectionTarget, VideoPlayerLaunch, VideoInspectionError, openVideoInspectionTarget, buildConfiguredVideoPlayerLaunch, defaultVideoPlayerLaunches.

### OpenRouter and execution

`src/openRouterEvaluation.ts:165` and `:190` wrap one or many benchmark model evaluations in Effect; they accept injected HTTP and video preparers. `:576` uses fetch against `/models` and `/chat/completions`, bearer authentication and JSON. The catalog is validated for video and structured output at `:688`; paid access is gated by caller. `:617` builds a soccer-specific system prompt and user text with five allowed classes and clip-relative timestamps, a strict named JSON schema, and `video_url`; settings include temperature, top_p, top_k, seed, max_tokens (default 4096) and reasoning. `:811` loads the entire MP4 and builds a `data:video/mp4;base64,` URL. This increases memory with clip size.

`src/benchmarkRun.ts:23` defaults to one provider request, one ffmpeg job, one active segment, no RPM cap, 300000 ms request timeout and two attempts. `src/benchmarkRunner.ts:73,285` schedules a shared model/segment grid, separate preparation and provider permits, rolling request start rate control, timeouts, aborts and serialized persistence. Prepared clips are shared across models and released. At `src/openRouterEvaluation.ts:515`, retryable failures include 408, 425, 429, 5xx and failures without an HTTP status, with 250ms times attempt delay; 429 also sets shared cooldown from Retry-After or 1s. 401/402/403 fail the evaluation. Other 4xx stop retry. `OpenRouterHttpError` carries status, sanitized body and retry-after; `OpenRouterEvaluationError` is a tagged Effect error and `ProviderAttemptTimeoutError` identifies timeout. Each segment records attempt count and failure stage. `:886` prefers usage.cost, otherwise estimates prompt/completion tokens times catalog per-token prices, else unknown. `:911` stores usage, completion ID/model, finish reasons and retry counts, plus status history. **Boundary:** response text is first choice message content, not the complete raw HTTP JSON; metadata is a selected subset (`:389,871`).

### Structured output and scorer

The JSON schema at `src/openRouterEvaluation.ts:1037` requires object `segment_kind` and `events`, disallows extra properties, and each event requires class, nonnegative timestamp, confidence 0..1 and nullable alternate prediction. `src/modelEvaluation.ts:193` parses JSON and validates kind against event count, class, timestamp, confidence and alternate. It does not enforce every strict JSON-schema constraint or bound timestamps to clip duration. It returns typed invalid reasons, never fabricates a valid prediction. `:291` scores at 2, 5 and 10 seconds using same-class nearest unmatched ground truth, predictions ordered by confidence, segment-relative timestamps and visibility filter; missing output adds false negatives. It calculates precision, recall, valid output rate, segment-kind accuracy and confidence-ranked per-class interpolated AP and mAP (`:398`), not current F1. The denominator for kind accuracy is valid segments. Tests cover malformed kind, alternate prediction, mAP, missing outputs and ranking (`src/modelEvaluation.test.ts:13,73,124,248`); provider tests cover request, eligibility, persistence, failures and multiple models (`src/openRouterEvaluation.test.ts:21`).

### SQLite and lifecycle

`src/store.ts:39` builds an Effect SQL layer and runs migrations for the writable database; `:69` offers read-only access. `src/migrations.ts:388` owns migrations. Selection, runs, model configuration, evaluation sections, ground truth, raw response text, parsed predictions, invalid predictions and scoring are persisted separately; section writes are incremental (`src/store.ts:312,379,409`). Results rehydrate predictions and recompute current metrics (`src/results.ts:179,211,219`); this does not reparse raw text. The CLI recognizes only `select-segments` and `create-run` (`src/cli.ts:47`). No benchmark resume command or loading unfinished cells was found in CLI or runner. Persisted state helps inspect failures but does not establish resumability. `src/prepareHistory.ts:9` prepares a separate migrated copy for UI use. Do not open this historical database through the writable migration layer.

The requested database is a historical schema at migrations 1 through 5, before current per-section and mAP additions. The `sqlite3` executable was absent. The schema below was obtained with Python sqlite3 using URI `mode=ro`, which enforces read-only access.

```sql
CREATE INDEX raw_model_responses_cost_latency_idx
        ON raw_model_responses (
          model_evaluation_id,
          cost_source,
          model_section_latency_ms
        )
      ;

CREATE INDEX segment_ground_truth_events_visibility_idx
        ON segment_ground_truth_events (
          segment_selection_id,
          segment_id,
          visibility
        )
      ;

CREATE TABLE benchmark_run_models (
          benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
          model_config_id TEXT NOT NULL,
          provider_model_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          invocation_settings_json TEXT NOT NULL,
          PRIMARY KEY (benchmark_run_id, model_config_id)
        );

CREATE TABLE benchmark_runs (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL,
          segment_selection_id TEXT NOT NULL REFERENCES segment_selections(id) ON DELETE RESTRICT,
          sample_budget INTEGER NOT NULL,
          random_seed INTEGER NOT NULL,
          context_before_seconds REAL NOT NULL,
          context_after_seconds REAL NOT NULL,
          scoring_include_not_shown_annotations INTEGER NOT NULL
        );

CREATE TABLE "effect_sql_migrations" (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE invalid_predictions (
          model_evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL,
          error TEXT NOT NULL,
          message TEXT NOT NULL,
          PRIMARY KEY (model_evaluation_id, segment_id)
        );

CREATE TABLE model_evaluations (
          id TEXT PRIMARY KEY,
          benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
          model_config_id TEXT NOT NULL,
          provider_model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (benchmark_run_id, model_config_id)
        );

CREATE TABLE parsed_model_predictions (
          id TEXT PRIMARY KEY,
          model_evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL,
          target_class TEXT NOT NULL,
          timestamp_seconds REAL NOT NULL,
          confidence REAL NOT NULL,
          alternate_prediction_json TEXT,
          FOREIGN KEY (model_evaluation_id, segment_id)
            REFERENCES parsed_segment_predictions(model_evaluation_id, segment_id)
            ON DELETE CASCADE
        );

CREATE TABLE parsed_segment_predictions (
          model_evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL,
          segment_kind TEXT NOT NULL,
          PRIMARY KEY (model_evaluation_id, segment_id)
        );

CREATE TABLE raw_model_responses (
          id TEXT PRIMARY KEY,
          model_evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
          benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
          model_config_id TEXT NOT NULL,
          segment_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL,
          response_text TEXT NOT NULL
        , provider_metadata_json TEXT, section_cost_usd REAL, cost_source TEXT NOT NULL DEFAULT 'unknown', segment_preparation_latency_ms INTEGER, model_section_latency_ms INTEGER);

CREATE TABLE scoring_results (
          model_evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
          evaluation_window_seconds REAL NOT NULL,
          true_positive_count INTEGER NOT NULL,
          false_positive_count INTEGER NOT NULL,
          false_negative_count INTEGER NOT NULL,
          event_precision REAL NOT NULL,
          event_recall REAL NOT NULL,
          event_f1 REAL NOT NULL,
          segment_kind_accuracy REAL NOT NULL,
          valid_output_rate REAL NOT NULL,
          PRIMARY KEY (model_evaluation_id, evaluation_window_seconds)
        );

CREATE TABLE segment_ground_truth_events (
          segment_selection_id TEXT NOT NULL,
          segment_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          match_id TEXT NOT NULL,
          match_half_id TEXT NOT NULL,
          half INTEGER NOT NULL,
          label TEXT NOT NULL,
          target_class TEXT NOT NULL,
          game_time TEXT NOT NULL,
          seconds REAL NOT NULL,
          position_ms INTEGER NOT NULL,
          team TEXT NOT NULL,
          visibility TEXT NOT NULL,
          PRIMARY KEY (segment_selection_id, segment_id, event_id),
          FOREIGN KEY (segment_selection_id, segment_id)
            REFERENCES video_segments(segment_selection_id, id)
            ON DELETE CASCADE
        );

CREATE TABLE segment_selections (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          soccernet_dir TEXT NOT NULL,
          sample_budget INTEGER NOT NULL,
          random_seed INTEGER NOT NULL,
          context_before_seconds REAL NOT NULL,
          context_after_seconds REAL NOT NULL,
          include_not_shown_anchors INTEGER NOT NULL,
          non_highlight_stride_seconds REAL NOT NULL,
          target_event_gap_seconds REAL NOT NULL,
          match_count INTEGER NOT NULL,
          match_half_count INTEGER NOT NULL,
          target_event_count INTEGER NOT NULL,
          candidate_count INTEGER NOT NULL
        );

CREATE TABLE video_segments (
          id TEXT NOT NULL,
          segment_selection_id TEXT NOT NULL REFERENCES segment_selections(id) ON DELETE CASCADE,
          match_id TEXT NOT NULL,
          match_half_id TEXT NOT NULL,
          source_video_path TEXT NOT NULL,
          start_seconds REAL NOT NULL,
          end_seconds REAL NOT NULL,
          segment_kind TEXT NOT NULL,
          selection_stratum TEXT NOT NULL,
          anchor_event_json TEXT,
          target_events_json TEXT NOT NULL,
          PRIMARY KEY (segment_selection_id, id)
        );
```

### Historical score check

The read-only query joined `scoring_results` and `model_evaluations` for `evaluation_window_seconds=5`. These are stored scores, not newly recomputed scores:

| Model | TP | FP | FN | Stored F1@5s |
| --- | ---: | ---: | ---: | ---: |
| google/gemini-3.1-flash-lite | 778 | 423 | 633 | 0.595712098 |
| qwen/qwen3.6-plus | 501 | 646 | 910 | 0.391712275 |
| google/gemini-3.5-flash | 550 | 149 | 861 | 0.521327014 |

Raw response row counts and valid counts:

- google/gemini-3.1-flash-lite: 1000 rows, 1000 valid.
- google/gemini-3.5-flash: 1000 rows, 568 valid.
- qwen/qwen3.6-plus: 1000 rows, 982 valid.


These counts support the stated rounded results. They do not prove fresh parsing and rescoring reproduces them. The current results UI recomputes from stored parsed predictions and current scorer, not raw response text, and historical inspection explicitly does not rescore (`../docs/research/README.md:78`). I found no existing offline CLI or test that reparses this historical database and reproduces historical F1. No such command was run. A future check should run the historical parser/scorer at its recorded revision against raw texts and the original selection, compare TP/FP/FN, and preserve visibility settings. Current scorer has no F1 field, although F1 can be derived from counts. Results for historical F1 and current mAP are not interchangeable.

## Flow

`src/cli.ts:150` discovers labels and videos, creates a seeded shared selection, saves it and creates the run. `src/benchmarkRunner.ts:73` drives segments across model configurations; it prepares each clip, executes provider calls with limits, writes per-section outcomes and scores at model completion. Results read stored selection/predictions to rescore (`src/results.ts:179`).

`src/soccernet.ts:25,40,136` recursively finds `Labels-v2.json`, validates `gameTime`, `label`, `position`, optional team and visibility with Effect Schema, associates annotations with a discovered matching half, normalizes target classes and visibility, and uses SHA256-derived stable IDs. The match directory contains the label file and half videos. Durations are inferred as at least 45 minutes or last event plus 60 seconds, not probed (`:216`). Both resolutions can exist in one directory, so inspect duplicate-half selection behavior before using this catalog for production.

Verified local dataset under `/home/pedro/tcc/benchmark/downloads`: 500 Labels-v2.json files, 550 each of `1_224p.mkv` and `2_224p.mkv`, and 12 each of `1_720p.mkv` and `2_720p.mkv`. Example labels path is `downloads/england_epl/2016-2017/2017-01-02 - 18-00 Sunderland 2 - 2 Liverpool/Labels-v2.json`. Counts are files, not necessarily matches with both labels and both videos.

`src/openRouterEvaluation.ts:773` executes exactly `ffmpeg -hide_banner -loglevel error -y -ss <startSeconds> -to <endSeconds> -i <sourceVideoPath> -map 0:v:0 -map 0:a? -c:v libx264 -preset veryfast -crf 28 -c:a aac -movflags +faststart <outputPath>`. Input seeking and re-encoding ordinarily permit accurate seek via decoding from an earlier seek point, subject to frame and timestamp granularity. No timing accuracy measurement was performed; verify with known-frame fixtures before assuming sample accuracy.

## Files Read

Root `AGENTS.md`, `CONTEXT-MAP.md`; benchmark `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `README.md`, `package.json`; root `mise.toml`; benchmark source and test declarations listed above, especially evaluator, scorer, runner, persistence, results and SoccerNet. Root `CLAUDE.md` and `CONTEXT.md` and benchmark `CONTEXT-MAP.md` were absent at the specified locations. Database schema and saved scoring rows were read in read-only mode. Python files were inventoried by names and module docstrings, not audited line by line.

## Boundaries

The benchmark is an evaluation harness, not an API or durable media-processing service. It uses Effect 3 `Effect.fn`/generators and `Effect.tryPromise`, tagged `Data.TaggedError`, `Schema.Struct` for incoming labels, SQL client layers and a managed runtime in the CLI (`src/store.ts:39`, `src/cli.ts:1`). No custom application Context service was established in the inspected modules. Execution dependencies are injectable ordinary objects and functions. `package.json` specifies Effect, Effect SQL SQLite Node, TypeScript and Vitest. `../mise.toml:61` typechecks via `pnpm exec tsc -p tsconfig.json --noEmit`; `:67` runs `pnpm exec vitest run` and two Python unittest modules. No lint task was found in the inspected mise tasks or package scripts. Tests were not run for this inspection.

Python inventory: `dataset.py` checks/downloads metadata; `download_224p.py` and `download_720p.py` download SoccerNet videos; `metadata_signal_analysis.py` and `metadata_discard_analysis.py` study metadata signals and discard rules; their corresponding `_test.py` files test them. `official_study.py` provides offline paired 17-class study tooling; `official_study_bootstrap.py` computes whole-match resampling; `official_study_concurrent.py` executes a frozen two-request study; `official_study_preflight.py` audits prerequisites; `official_study_provider.py` is its OpenRouter paid-call adapter; `official_study_recall_export.py` exports audited links and recall; `official_study_reservation_v2.py` handles reservation accounting; `hydrogen_campaign.py` runs a paid Gemini campaign. Matching `_test.py` files test those modules except the download/preflight tools. These descriptions come from module docstrings and names, not full implementation audits. Moving download and study scripts to TypeScript requires checking their SoccerNet/Python library dependencies first.

## Non-Obvious Things

- `raw_model_responses.response_text` is extracted first-choice text. The full provider payload is not archived, despite the name.
- Legacy scores are already stored, but that is not the same as reproducing them from raw responses.
- The source-video catalog estimates half duration from annotations. If a file has both resolutions, both may be discovered, with events associated to the first matching half.
- The temporary MP4 is read fully into a base64 string. Active segments and request concurrency affect memory.
- Provider hard account errors abort rather than becoming individual invalid predictions; failed provider calls are not schema-invalid outputs.

## Open Questions

- Which historical commit and scorer settings produced this database, and can its original scorer reparse all raw texts to recover these exact counts?
- What video seek error is acceptable for the intended highlight product, and what do frame-level checks show?
- Will the production API need job recovery after restart, full provider payload retention, streaming uploads, multi-user access, or model-specific output contracts? These are not demonstrated by the benchmark.

## Reuse verdict

- `domain.ts`: adapt benchmark terms and five-class contract to product jobs and outputs.
- `openRouterEvaluation.ts`: adapt. Useful request building, errors, retry and cost logic, but tightly coupled to benchmark schema, selection and scoring. Extract transport and policy; test memory and provider compatibility.
- `benchmarkRunner.ts`: adapt scheduling concepts, not as-is for durable jobs or resume. Verify fairness and cancellation requirements.
- `modelEvaluation.ts`: adapt parser if output contract remains identical. Reuse scorer for benchmark evaluation, not as the product rule filter.
- `store.ts` and `migrations.ts`: adapt Effect SQLite patterns and transaction approach. Design product-specific jobs, media, stages and restart semantics.
- `soccernet.ts` and `selection.ts`: reuse for offline benchmark data; adapt discovery if multiple resolutions coexist. Selection is benchmark-specific, not YOLO candidate filtering.
- `results.ts`: adapt query and rescore patterns to review UI. Historical schema needs separate handling.
- `benchmarkRun.ts`, `cli.ts`, `ui*`, `videoInspection.ts`, `prepareHistory.ts`: adapt or retain as benchmark tools; they do not constitute the new API. Python download/study tools can remain offline until replacements are justified.
