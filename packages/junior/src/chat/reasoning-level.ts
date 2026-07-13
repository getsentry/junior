import { z } from "zod";

export const TURN_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type TurnReasoningLevel = (typeof TURN_REASONING_LEVELS)[number];

/** Validate a configured main-agent reasoning level. */
export function parseTurnReasoningLevel(value: unknown): TurnReasoningLevel {
  return z.enum(TURN_REASONING_LEVELS).parse(value);
}
