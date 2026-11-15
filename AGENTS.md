# Project

The local TypeScript API follows [the API design](docs/design/video-analysis-api.md). Leave the Python study and thesis intact.

## Repository structure

- `apps/server/src/` contains the TypeScript API, CLI, services, and SQLite persistence.
  - `api/` contains blob endpoints and HTTP tests. `http.ts` wires the API handlers.
  - `jobs/` owns job state, pipeline orchestration, sources, and highlights.
  - `cv/` connects the server to the local Python worker.
  - `domain/` implements rule filtering, segment planning, and prediction merging.
  - `media/` probes videos and encodes clips.
  - `llm/` handles OpenRouter requests, rate limits, and the spending ledger.
  - `eval/` contains scoring, model comparison, rule evaluation, and tuning tools.
- `packages/contracts/src/` defines shared Effect Schema contracts for the API and domain.
- `workers/cv/` contains the Python CV worker, reference adapter, and benchmark tools. The worker reuses the study's inference code and root `best.pt` weights.
- `fixtures/rule-config-c/` contains rule fixtures and their generator.
- `scripts/` contains study-data export tools.
- `docs/design/` contains the API design, research notes, and evaluation results.
- `docs/api/` contains the HTML API reference and local setup guide.
- `src/`, `tests/`, and the root Python configuration belong to the original Python study.
- `latex/` contains the thesis. `analysis_output/`, `output/`, `reports/`, and `saved_rules/` contain study artifacts.

The root pnpm workspace configures TypeScript tooling. Server tests live beside the code they exercise. The root `tests/` directory is for Python tests.

# Effect

- Reusable Effect functions use Effect.fn("Service.operation") with stable span names. Keep Effect.gen for inline programs and layer construction.
- Failures use Schema.TaggedError with structured operation, resource and cause fields.
- Services use Context.Service with inline interfaces and Layer.effect. Inject dependencies through the Effect environment.
- runPromise, runPromiseExit and ManagedRuntime belong only at application and framework boundaries.
- Prefer inferred types. Never use any.
- Default to no comments. Explain only constraints the code cannot express.
- Test behavior through the service. Fake only external dependencies.
- Test at the lowest layer that fails. Do not duplicate tests across wrappers.
- it.effect uses TestClock. Use it.live for subprocess and network fixtures.
- Never poll with sleep or yieldNow in tests. Await Deferred, Queue or completion.
