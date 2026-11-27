// Operational kill switches. Each one defaults to on.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

/** Kill switch fields at the top level of the config. */
export const killSwitchFields = {
  /** Kill switch for prompt cache warming. Defaults to true. */
  cacheWarmingEnabled: z.boolean().default(true),
  /**
   * Kill switch for compaction on idle: a warmup of a prefix at or above the
   * background compaction mark swaps in a ready background summary instead.
   * Defaults to true. It runs only while cache warming is on.
   */
  idleCompactionEnabled: z.boolean().default(true),
  conversationWorkEnabled: z.boolean().default(true),
};

/** Env var that sets each kill switch, for error messages. */
export const killSwitchEnvNames: Record<string, string> = {
  cacheWarmingEnabled: "JUNIOR_CACHE_WARMING_ENABLED",
  idleCompactionEnabled: "JUNIOR_IDLE_COMPACTION_ENABLED",
  conversationWorkEnabled: "JUNIOR_CONVERSATION_WORK_ENABLED",
};

// Operational kill switches default to on. Only "false" turns them off.
function parseKillSwitch(name: string, rawValue: string | undefined): boolean {
  const value = toOptionalTrimmed(rawValue)?.toLowerCase();
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

/** Read the kill switches from env. */
export function readKillSwitchesEnv(env: Env) {
  return {
    cacheWarmingEnabled: parseKillSwitch(
      "JUNIOR_CACHE_WARMING_ENABLED",
      env["JUNIOR_CACHE_WARMING_ENABLED"],
    ),
    idleCompactionEnabled: parseKillSwitch(
      "JUNIOR_IDLE_COMPACTION_ENABLED",
      env["JUNIOR_IDLE_COMPACTION_ENABLED"],
    ),
    conversationWorkEnabled: parseKillSwitch(
      "JUNIOR_CONVERSATION_WORK_ENABLED",
      env["JUNIOR_CONVERSATION_WORK_ENABLED"],
    ),
  };
}
