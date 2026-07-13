import { z } from "zod";

export const TURN_THINKING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type TurnThinkingLevel = (typeof TURN_THINKING_LEVELS)[number];

/** Validate a configured main-agent reasoning level. */
export function parseTurnThinkingLevel(value: unknown): TurnThinkingLevel {
  return z.enum(TURN_THINKING_LEVELS).parse(value);
}
