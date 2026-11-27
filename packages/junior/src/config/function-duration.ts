// The function duration, and the turn and conversation work deadlines that
// come from it.
import * as z from "zod";

const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;
/** Shortest agent turn timeout. */
export const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
/**
 * Buffer between the Vercel function timeout and the agent turn timeout so
 * Junior can abort, persist, and schedule continuation before host teardown.
 */
export const FUNCTION_TIMEOUT_BUFFER_SECONDS = 20;
/** Additional buffer that makes conversation work yield before the hard request deadline. */
const CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS = 40;

/** Max duration of the Vercel function, in seconds. */
export const functionMaxDurationSecondsSchema = z
  .number()
  .default(DEFAULT_FUNCTION_MAX_DURATION_SECONDS);

/** Longest agent turn the function duration allows, after the teardown buffer. */
export function resolveMaxTurnTimeoutMs(
  functionMaxDurationSeconds: number,
): number {
  const budgetSeconds =
    functionMaxDurationSeconds - FUNCTION_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

/** When conversation work yields, so it stops before the request deadline. */
export function resolveConversationWorkSoftYieldAfterMs(
  functionMaxDurationSeconds: number,
): number {
  return Math.max(
    MIN_AGENT_TURN_TIMEOUT_MS,
    (functionMaxDurationSeconds - CONVERSATION_WORK_SOFT_YIELD_BUFFER_SECONDS) *
      1000,
  );
}
