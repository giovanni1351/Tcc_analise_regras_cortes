# Project

The local TypeScript API follows docs/design/video-analysis-api.md. Shared Effect Schema contracts live in packages/contracts. Services, persistence and CLI live in apps/server. Leave the Python study and thesis intact. Rule fixtures live in fixtures/rule-config-c.

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
