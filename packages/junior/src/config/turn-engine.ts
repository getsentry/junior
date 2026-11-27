// The Turn engine switch: which engine runs the Turns of every input that
// main's mailbox send receives. `main` is the mailbox worker in `chat/`, and
// `core` is the Turn engine in `core/`.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

/** The engine that runs Turns. Defaults to `main`. */
export const turnEngineFields = {
  turnEngine: z.enum(["main", "core"]).default("main"),
};

/** Env var that sets the Turn engine, for error messages. */
export const turnEngineEnvNames: Record<string, string> = {
  turnEngine: "JUNIOR_TURN_ENGINE",
};

function parseTurnEngine(
  rawValue: string | undefined,
): "main" | "core" | undefined {
  const value = toOptionalTrimmed(rawValue);
  switch (value) {
    case undefined:
    case "main":
    case "core":
      return value;
    default:
      throw new Error("JUNIOR_TURN_ENGINE must be main or core");
  }
}

/** Read the Turn engine from env. */
export function readTurnEngineEnv(env: Env) {
  return { turnEngine: parseTurnEngine(env["JUNIOR_TURN_ENGINE"]) };
}
