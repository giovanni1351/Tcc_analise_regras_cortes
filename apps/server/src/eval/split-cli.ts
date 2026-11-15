import { Console, Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { studySplit } from "./split.ts";
NodeRuntime.runMain(Console.log(JSON.stringify(studySplit, null, 2)).pipe(Effect.asVoid));
