import { Context, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ProcessError extends Schema.TaggedError<
  ProcessError,
  { readonly brand: unique symbol }
>()("ProcessError", { command: Schema.String, cause: Schema.Defect() }) {}
export class Process extends Context.Service<
  Process,
  {
    readonly spawn: (
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, ProcessError, Scope.Scope>;
  }
>()("@tcc/server/process") {}
export const processLayer = Layer.effect(
  Process,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return {
      spawn: Effect.fn("Process.spawn")((command: string, args: ReadonlyArray<string>) =>
        spawner
          .spawn(ChildProcess.make(command, args))
          .pipe(Effect.mapError((cause) => new ProcessError({ command, cause }))),
      ),
    };
  }),
);
