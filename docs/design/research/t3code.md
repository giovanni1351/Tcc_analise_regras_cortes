# Components Found

Verified against shallow clone commit `3e1761821226c472318168238c7599eea26dc49c`. Versions are the checkout's pins, not a recommendation of the newest releases. No dependencies were installed and no commands were executed in the clone.

- `package.json` pins pnpm 12.14.0, Node 26.13.1, `@effect/tsgo` 0.67.1 and `vite-plus` catalog 1.4.0. The lockfile resolves oxlint 1.89.0, oxfmt 0.74.0, `@oxlint/plugins` 1.89.0. Vite+ runs oxlint and oxfmt. `eslint` is an oxlint plugin name, not evidence of a separate ESLint runner. No root Biome configuration was found.
- Root commands are `vp lint --report-unused-disable-directives`, `vp fmt`, `vp fmt --check`, `vp run -r --cache --concurrency-limit 4 typecheck`, and `vp run -r test`. Per-server typecheck is `effect-tsgo tsrs --noEmit`, not standard tsc. AGENTS says Effect diagnostics are built in. The lockfile contains TypeScript transitively, so do not interpret that as zero TypeScript packages anywhere.
- `vite.config.ts` owns lint, format and test configuration. It loads `./oxlint-plugin-t3code/index.ts` and `@shadcn/lint` 0.1.5. The former includes `t3code/prefer-effect-fn`; it is a project plugin, not a separately published Effect lint plugin. Type-aware oxlint is disabled in that config. The Effect diagnostics are configured in `tsconfig.effect.json`, inherited by `tsconfig.base.json`; the name `@effect/language-service` is a plugin setting, but no direct dependency pin for that package was found. Do not assume it is independently installed at a specific version. The checker is `@effect/tsgo`.
- `pnpm-workspace.yaml` catalogs `effect: 4.1.3`, `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/platform-bun`, `@effect/sql-pg`, `@effect/sql-sqlite-do`, and `@effect/vitest` at 4.1.2. This is Effect 4, not v3. It imports core subpaths including `effect/rpc`, `effect/sql`, `effect/http-api`, and `effect/process`; it does not require a package named effect-smol in the inspected manifests. Node server depends on platform-node and platform-node-shared; the presence of Bun and other SQL packages in the catalog does not mean the local server uses them.
- Local server persistence is `apps/server/src/persistence/Sqlite.ts`, using `@t3tools/shared/nodeSqliteClient`, a repository adapter over Node SQLite, with reader and writer workers. It provides Effect `SqlClient`. `layerMemory` uses `:memory:`. `Migrations.ts` imports numbered migration modules, builds a `Migrator.fromRecord` loader and uses `Migrator.make`; SQLite setup runs migrations at layer initialization. Its CLI acquires an ownership lock before pending migrations. Relay PostgreSQL migration SQL under `infra/relay/migrations/postgres` is a separate concern.


`vite.config.ts:214-252`:

```
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "infra/task-cache/vendor/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "react/no-object-type-as-default-prop": "off",
```

`tsconfig.base.json:1-24`:

```
{
  // The Effect language service config lives apart so apps/mobile can extend it with Expo's base.
  "extends": "./tsconfig.effect.json",
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

Full Effect diagnostic configuration, including its explicit exceptions and overrides:

`tsconfig.effect.json:1-135`:

```
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "namespaceImportPackages": ["@effect/platform-node", "effect"],
        "effectFn": ["span", "inferred-span", "suggested-span"],
        "diagnosticSeverity": {
          "abortControllerInEffect": "error",
          "runEffectInsideEffect": "error",
          "flatMapConditionalToFilterOrFail": "error",
          "catchConditionalRefailToCatchIf": "error",
          "tryCatchInEffectGen": "error",
          "schemaStructWithTag": "error",
          "preferTypedSchemaDecoder": "error",
          "catchUnfailableEffect": "error",
          "raceFirstWithSleepToTimeout": "error",
          "redundantMapError": "error",
          "optionMatchToFromOption": "error",
          "catchToIgnore": "error",
          "unnecessaryEffectGen": "error",
          "allOfMapToForEach": "error",
          "catchToOrElseSucceed": "error",
          "unnecessaryFailYieldableError": "error",
          "preferSucceedSomeOrNone": "error",
          "effectSucceedWithVoid": "error",
          "provideLayerSucceedToProvideService": "error",
          "flatMapIgnoredParamToAndThen": "error",
          "mapSomeToAsSome": "error",
          "unnecessaryPipeChain": "error",
          "returnEffectInGen": "off",
          "effectFnOpportunity": "error",
          "anyUnknownInErrorContext": "error",
          "unsafeEffectTypeAssertion": "error",
          "instanceOfSchema": "error",
          "deterministicKeys": "error",
          "strictEffectProvide": "off",
          // We use Effect's unstable modules (http, sql) on purpose. These rules
          // also make effect-tsgo 0.47+ report false TS2790 errors on `delete`.
          "unstableApiUsage": "off",
          "experimentalApiUsage": "off",
          "missingEffectServiceDependency": "error",
          "leakingRequirements": "error",
          "globalErrorInEffectCatch": "error",
          "globalErrorInEffectFailure": "error",
          "unknownInEffectCatch": "error",
          "strictBooleanExpressions": "off",
          "lazyEffect": "off",
          "globalJsonInEffect": "error",
          "schemaSyncInEffect": "error",
          "cryptoRandomUUID": "error",
          "cryptoRandomUUIDInEffect": "error",
          "nodeBuiltinImport": "error",
          "globalDate": "error",
          "globalDateInEffect": "error",
          "globalConsole": "error",
          "globalConsoleInEffect": "error",
          "globalRandom": "error",
          "globalRandomInEffect": "error",
          "globalTimers": "error",
          "globalTimersInEffect": "error",
          "globalFetch": "error",
          "globalFetchInEffect": "error",
          "acquireReleaseDisposable": "error",
          "catchAllTagDispatchToCatchTag": "error",
          "catchAllToMapError": "error",
          "catchChainToFirstSuccessOf": "error",
          "catchDieToOrDie": "error",
          "catchIfTagToCatchTag": "error",
          "catchRefailToTapError": "error",
          "catchTagToCatchReason": "error",
          "effectMapFlatten": "error",
          "effectMapVoid": "error",
          "effectSleepZeroToYieldNow": "error",
          "effectSucceedWithUndefined": "error",
          "errorPayloadShadowsName": "error",
          "failCauseToConstructor": "error",
          "flatMapIdentityToFlatten": "error",
          "flatMapToMap": "error",
          "flatMapToTap": "error",
          "manualMetricTapToTrack": "error",
          "mapConstToAs": "error",
          "mapSomeCatchNoSuchElement": "error",
          "matchBooleanToIsSuccess": "error",
          "matchEffectToMapBoth": "error",
          "matchEffectToMatch": "error",
          "matchToResultOrOption": "error",
          "multipleCatchTag": "error",
          "preferUnsafeConstructor": "error",
          "redundantOrDie": "error",
          "redundantSchemaTagIdentifier": "error",
          "resultMatchToFromResult": "error",
          "runOfExitToRunExit": "error",
          "suspendFailToFailSync": "error",
          "syncToSucceed": "error",
          "timeoutCatchTagToTimeoutOrElse": "error",
          "unnecessaryPipe": "error",
          "unnecessaryTypeofType": "error",
          "effectTryWithoutCatch": "error",
          "processEnvInEffect": "error",
          "preferSchemaTaggedError": "error",
          "extendsNativeError": "error",
          "schemaNumber": "off"
        },
        "overrides": [
          {
            "include": ["**/*.test.ts", "**/*.test.tsx"],
            "options": {
              "diagnosticSeverity": {
                "globalJsonInEffect": "off",
                "effectFnOpportunity": "off"
              }
            }
          },
          {
            "include": [
              "**/*.spec.ts",
              "**/*.spec.tsx",
              "**/*.testkit.ts",
              "**/*.testkit.tsx",
              "**/test/**/*",
              "**/tests/**/*",
              "**/testkit/**/*",
              "**/testing/**/*",
              "**/fixtures/**/*",
              "**/integration/**/*",
              "packages/provider-testing/**/*"
            ],
            "options": { "diagnosticSeverity": { "effectFnOpportunity": "off" } }
          }
        ]
      }
    ]
  }
}
```

# Flow

`packages/contracts/src/rpc.ts` defines `Rpc.make` schemas and RPC groups. `apps/server/src/ws.ts` installs handlers for those groups via Effect RPC on an authenticated WebSocket. `packages/client-runtime/src/rpc` owns shared client access for web and mobile. The contracts also define HTTP APIs, and `packages/client-runtime/src/rpc/http.ts` builds `HttpApiClient` clients. HTTP exists alongside WebSocket, not merely as a WebSocket upgrade. `packages/contracts/src/baseSchemas.ts` applies `Schema.brand` to entity IDs. Both wire input and errors use Effect Schema.


`packages/contracts/src/rpc.ts:634-650`:

```
const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});
```

Server features live in services. Handlers decode, call a service, and map errors. `docs/internals/effect-services.md` prescribes `Context.Service` with inline interface, `make` and `Layer.effect`; dependencies come from the Effect environment. It prescribes `Schema.TaggedError`, and typed attributes with immediate causes. Layers compose via `Layer.provide`, `provideMerge`, and `mergeAll`. `Effect.fn("Service.operation")` makes tracing spans; `Effect.fnUntraced` is reserved for high-frequency or already-covered work. Logging uses a logger layer in `apps/server/src/serverLogger.ts`; `apps/server/src/cli/config.ts` reads `Config` values and defaults, including OTLP endpoints. `NativeAppIconResolver.ts` injects `ChildProcessSpawner` and uses `ChildProcess.make`, a useful example for an ffmpeg adapter. `Orchestrator.ts` returns `Stream.Stream` values and explicitly uses concurrency 1 in some paths; this is not a universal concurrency policy.

# Files Read

`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vite.config.ts`, `tsconfig.base.json`, `tsconfig.effect.json`, `apps/server/package.json`, `packages/contracts/package.json`, `oxlint-plugin-t3code/package.json`, `AGENTS.md`, `CLAUDE.md`, `docs/internals/effect-services.md`, `apps/server/src/persistence/Sqlite.ts`, `apps/server/src/persistence/Migrations.ts`, `apps/server/src/cli/config.ts`, `apps/server/src/assets/NativeAppIconResolver.ts`, its test, `apps/server/src/auth/EnvironmentAuth.test.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/ws.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/baseSchemas.ts`, `packages/client-runtime/src/rpc/http.ts`. Searches also sampled imports, configuration and workspace files. `CLAUDE.md` contains `@AGENTS.md`; `.cursor/rules/cursor-cloud.mdc` exists but was not established as an Effect rule.

# Boundaries

The investigation is static and representative, not an exhaustive survey of all 32,000 files. No runtime verification, installs or tests were performed. `@effect/vitest` is patched at 4.1.2 in `pnpm-workspace.yaml` using `patches/@effect__vitest@4.1.2.patch` to import `vite-plus/test`, with a package extension. Copying that setup requires the patch and compatible tooling. Example `EnvironmentAuth.test.ts` composes the real service with `SqlitePersistence.layerMemory` and test layers for dependencies; `NativeAppIconResolver.test.ts` uses `Layer.mock` for the process spawner. Tests use both real lightweight implementations and fakes, not a ban on mocks.

# Non-Obvious Things

`AGENTS.md` and `docs/internals/effect-services.md` are the main explicit Effect guidance. The following are verbatim excerpts, not independent recommendations:


`AGENTS.md:200-207`:

```
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction.
  Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event
  projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby.
  Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and
  options, and pass combinators as additional function-builder arguments.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `t3code/no-low-value-comments` enforces the length cap and the mechanical cases.
```

`docs/internals/effect-services.md:43-65`:

```
references.

```ts
export class FooWriteError extends Schema.TaggedError<FooWriteError>()("FooWriteError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Failed to write the foo file.";
  }
}

export class Foo extends Context.Service<
  Foo,
  { readonly write: (input: { readonly path: string }) => Effect.Effect<void, FooWriteError> }
>()("t3/area/Foo") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // ...
  return Foo.of({ write });
});

```

Further verbatim rules:

> Tests exercise behavior through the service, with test layers only for external dependencies. Don't mock the logic under test.

> `ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong at application and framework boundaries: React, native callbacks, the CLI, HTTP adapters. Never in a domain service, repository, persistence code, or service constructor.

> Failures are `Schema.TaggedError` classes with structured attributes: the operation or stage, the resource path or entity id, a normalized category or status.

`AGENTS.md` testing instructions include these verbatim:

> `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.

> No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.

> Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.

The first two testing excerpts omit their list markers only. Full policy and error details are in the source files. `CLAUDE.md` delegates to `AGENTS.md`.

# Open Questions

- Inference: HTTP endpoints plus shared Schema contracts may be enough for an initial local video API; streaming progress could justify WebSocket or another streaming transport later. This checkout does not establish which is best for video analysis.
- Decide whether the project wants Effect 4 specifically, and verify compatibility of the desired OpenRouter client and ffmpeg/process libraries before adopting its pins. No compatibility tests were run.
- Confirm editor installation and versioning of the Effect language service separately. The repository's `@effect/tsgo` checker is pinned, but its tsconfig plugin name alone does not prove an independently installed language-service version.

# Copy list

1. Copy `tsconfig.base.json` and `tsconfig.effect.json` as a starting point only after choosing Effect 4 and `@effect/tsgo` 0.67.1; adjust runtime/module choices and diagnostics to your code. Preserve the full diagnostic list above if exact parity is the goal.
2. Copy root script shapes for `lint`, `fmt`, `fmt:check`, `typecheck`, and `test` from `package.json`, adapting recursive `vp run` to actual workspace scripts. Add Vite+ 1.4.0 and pnpm workspace catalog pins explicitly. `vite.config.ts` lint categories and formatter settings are a useful reference, but cannot be copied wholesale without its custom plugin, shadcn plugin, and many repo-specific overrides.
3. Adopt the service and error conventions in `docs/internals/effect-services.md`, especially dependency injection, thin transports, named Effect functions and typed error causes. Use Schema contracts and semantic brands for IDs at the boundary. Model ffmpeg as an injected process service and test with a fake spawner where appropriate. These are recommendations inferred from the examples, not proof of the video system's requirements.
4. Start tests with `@effect/vitest`, focused service behavior, in-memory persistence where needed, and deterministic synchronization. If using Vite+ exactly as this repo does, include its matching patch and package extension and check they remain compatible with your chosen versions.
5. Do not copy T3-specific `oxlint-plugin-t3code` rules, the desktop/mobile UI and provider rules, event-sourced orchestration, migration history, custom SQLite worker adapter, PR workflow, dependency overrides or generated-file ignores without a demonstrated need. Extract individual generic rules only with their implementation and tests.
