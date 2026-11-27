// The state group: the adapter that holds locks and short-lived state.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

/** The state adapter. */
export const stateSchema = z
  .strictObject({
    adapter: z.enum(["memory", "redis"]).default("redis"),
    keyPrefix: z.string().optional(),
    redisUrl: z.string().optional(),
  })
  .prefault({});

/** Env var that sets each state field, for error messages. */
export const stateEnvNames: Record<string, string> = {
  "state.adapter": "JUNIOR_STATE_ADAPTER",
  "state.keyPrefix": "JUNIOR_STATE_KEY_PREFIX",
  "state.redisUrl": "REDIS_URL",
};

/** Read the state group from env. */
export function readStateEnv(env: Env): z.input<typeof stateSchema> {
  return {
    adapter:
      env["JUNIOR_STATE_ADAPTER"]?.trim().toLowerCase() === "memory"
        ? "memory"
        : undefined,
    keyPrefix: toOptionalTrimmed(env["JUNIOR_STATE_KEY_PREFIX"]),
    redisUrl: toOptionalTrimmed(env["REDIS_URL"]),
  };
}
