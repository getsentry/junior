import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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

/** Convert a reasoning level into the Pi Agent setting for a main Turn. */
export function toPiReasoningLevel(
  level: TurnReasoningLevel,
): ThinkingLevel | "off" {
  return level === "none" ? "off" : level;
}
