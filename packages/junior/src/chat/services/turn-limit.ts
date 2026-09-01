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

/** True when a turn hit a hard execution limit and should not resume. */
export function isTurnExecutionLimitExceededError(error: unknown): boolean {
  return (
    error instanceof TurnSliceLimitExceededError ||
    error instanceof TurnToolCallLimitExceededError
  );
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

/** Walk Error.cause so boundary wrappers still surface the limit stop. */
function isTurnExecutionLimitCause(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current)) {
    if (isTurnExecutionLimitExceededError(current)) {
      return true;
    }
    seen.add(current);
    current =
      current instanceof Error && "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}

/**
 * Pick the user-facing failure reply for a thrown turn error.
 * Execution-limit stops use the limit copy; everything else stays generic.
 */
export function buildTurnErrorResponse(
  error: unknown,
  eventId: string,
  buildGenericFailureResponse: (eventId: string) => string,
): string {
  return isTurnExecutionLimitCause(error)
    ? buildTurnLimitResponse(eventId)
    : buildGenericFailureResponse(eventId);
}
