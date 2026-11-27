// Types and field schemas that several config groups share.
import * as z from "zod";

/** Env vars as `loadConfig` receives them. */
export type Env = Record<string, string | undefined>;

/**
 * A check that only createApp options reach. Its message names the option,
 * so it stands alone without a field path or env var.
 */
export function optionCheck(message: string) {
  return { message, params: { option: true } };
}

/** A positive integer field. */
export const positiveInt = z.number().int().positive();
