import { buildTurnFailureResponse } from "@/chat/logging";

/** Terminal failure when one turn uses too many execution slices. */
export class TurnSliceLimitExceededError extends Error {
  constructor(maxSlices: number) {
    super(`Agent turn exceeded execution limit (${maxSlices} slices)`);
    this.name = "TurnSliceLimitExceededError";
  }
}

/** Terminal failure when one turn uses too many tool calls. */
export class TurnToolCallLimitExceededError extends Error {
  constructor(maxToolCalls: number) {
    super(`Agent turn exceeded execution limit (${maxToolCalls} tool calls)`);
    this.name = "TurnToolCallLimitExceededError";
  }
}

/** Terminal failure when one turn spends past its cost budget. */
export class TurnBudgetExceededError extends Error {
  constructor(maxCostUsd: number) {
    super(`Agent turn exceeded execution limit ($${maxCostUsd} budget)`);
    this.name = "TurnBudgetExceededError";
  }
}

function isDirectTurnExecutionLimitError(error: unknown): boolean {
  return (
    error instanceof TurnSliceLimitExceededError ||
    error instanceof TurnToolCallLimitExceededError ||
    error instanceof TurnBudgetExceededError
  );
}

/** True when a turn hit a hard execution limit, including one Error.cause wrap. */
export function isTurnExecutionLimitExceededError(error: unknown): boolean {
  if (isDirectTurnExecutionLimitError(error)) {
    return true;
  }
  return error instanceof Error && isDirectTurnExecutionLimitError(error.cause);
}

/**
 * Why tools are disabled once a turn is out of budget. Junior blocks the call
 * with the same message as a tool that `disableTools` disabled. The tool list
 * stays the same, so the provider cache stays valid.
 */
export const TURN_LIMIT_DISABLED_REASON =
  "This Turn used its execution budget, so all tools are disabled. Reply " +
  "now with what you finished, what is left, and how to continue.";

/** What one tool call may do after the turn limits are checked. */
export type TurnLimitDecision = "allow" | "wrap_up" | "stop";

/**
 * Check tool calls against the turn limits for one slice.
 *
 * The first model step past a limit gets `wrap_up`: its tool calls are blocked
 * and the model can reply with its progress. A later step that still calls
 * tools gets `stop`, which ends the turn with an execution-limit error.
 */
export function createTurnLimitGate(): (args: {
  assistantMessage: object;
  overLimit: boolean;
}) => TurnLimitDecision {
  let wrapUpStep: object | undefined;
  return ({ assistantMessage, overLimit }) => {
    if (!overLimit) {
      return "allow";
    }
    wrapUpStep ??= assistantMessage;
    return wrapUpStep === assistantMessage ? "wrap_up" : "stop";
  };
}

/** Explain a terminal turn execution limit with actionable recovery guidance. */
export function buildTurnLimitResponse(eventId: string): string {
  return (
    "I couldn't finish this request because this turn reached its execution limit. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}

/** User-facing reply for a thrown turn error. */
export function buildTurnErrorResponse(
  error: unknown,
  eventId: string,
): string {
  return isTurnExecutionLimitExceededError(error)
    ? buildTurnLimitResponse(eventId)
    : buildTurnFailureResponse(eventId);
}
