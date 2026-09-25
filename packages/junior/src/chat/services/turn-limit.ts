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

function isDirectTurnExecutionLimitError(error: unknown): boolean {
  return (
    error instanceof TurnSliceLimitExceededError ||
    error instanceof TurnToolCallLimitExceededError
  );
}

/** True when a turn hit a hard execution limit, including one Error.cause wrap. */
export function isTurnExecutionLimitExceededError(error: unknown): boolean {
  if (isDirectTurnExecutionLimitError(error)) {
    return true;
  }
  return error instanceof Error && isDirectTurnExecutionLimitError(error.cause);
}

/** Stop the turn when its tool-call count is past the limit. */
export function assertTurnToolCallLimit(
  toolCallCount: number,
  maxToolCalls: number,
): void {
  if (toolCallCount <= maxToolCalls) {
    return;
  }
  throw new TurnToolCallLimitExceededError(maxToolCalls);
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
