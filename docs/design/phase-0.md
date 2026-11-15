# Phase 0 API

Install the mise tools, then run `pnpm install`. Run `pnpm start serve` to listen on `127.0.0.1:3000`. Run `pnpm start budget` in another terminal to call the generated HttpApi client.

`TCC_PORT` overrides the port for both commands. `TCC_DATA_DIR` overrides the data directory. Otherwise the server uses `$XDG_DATA_HOME/tcc-highlights`, falling back to `$HOME/.local/share/tcc-highlights`. `OPENROUTER_BUDGET_USD` defaults to zero. The server owns the database and holds a scoped Linux `flock` process. This requires util-linux, sh and cat. The CLI budget command never opens the database.

The migration creates all eleven domain tables. Ordinary jobs have a unique source and spec hash. Forced jobs bypass that partial index. Stage keys and media hashes are primary keys. Budget reservations include ambiguous attempts; ambiguousUsd is the ambiguous subset of reservedUsd. Actual provider costs replace reservations. Future job admission must account for this overlap.

All ten HTTP endpoints are declared. Only GET /budget is implemented. Valid requests to other endpoints return the typed NotImplemented error with HTTP 501. Invalid requests fail schema decoding first. Blob streaming and Range handling belong to the later implementation.

The shared rule default is defaultRuleConfig. It contains only config C's active Zero parameters. Golden fixtures remain in fixtures/rule-config-c. The benchmark JSON predictionSchema and targetEventClasses are preserved, alongside the corresponding LlmVerdict Effect Schema. Future parsing must reject excess properties and check finish reason and clip duration as specified in the design.

## Version deviations

The design pins conflict with the requirement that packages be published at least two weeks before November 14, 2026. npm records Effect 4.1.3 on November 10, the t3code companion packages 4.1.2 on November 2, and tsgo 0.67.1 on November 4. Phase 0 uses Effect and companion packages 4.1.1 from October 30, and tsgo 0.63.0 from October 28. Node 26.13.1 installed successfully. pnpm minimumReleaseAge applies the two-week policy to dependency resolution too.

The copied tsconfig.effect.json omits eight diagnostics that tsgo 0.63.0 does not recognize. It disables multipleEffectProvide, which the reference did not configure, and allows the required native node:http import in the CLI adapter only. Services use deterministic keys required by the copied configuration. TypeScript 7.0.2 supplies the compiler selected by effect-tsgo tsc.

The lint configuration preserves generic reference categories and rule overrides. Overrides requiring t3code, shadcn, React or reference-only paths are omitted. Formatter and lint scripts use explicit paths because the study's transport-stream ignore pattern also matches TypeScript. The existing Python files are outside those commands.

Half is nullable for local videos whose broadcast half is unknown. The job result still exposes half explicitly. Job transitions, crash recovery for jobs and attempts, artifact publication, rule execution and all analysis stages remain outside phase 0.

## Verification

`pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test` verify the workspace. The tests run migrations against memory and a reopened file database, interrupt a real child and check its PID, call a live HTTP server through the generated client, verify ledger arithmetic, reject a second lock and reacquire a released lock. No OpenRouter requests are made.
