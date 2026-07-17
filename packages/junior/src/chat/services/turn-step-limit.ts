/** Terminal failure raised when one agent turn exhausts its step budget. */
export class TurnStepLimitExceededError extends Error {
  constructor(maxSteps: number) {
    super(`Agent turn exceeded step limit (${maxSteps})`);
    this.name = "TurnStepLimitExceededError";
  }
}

/** Explain a terminal turn step limit with actionable recovery guidance. */
export function buildTurnStepLimitResponse(eventId: string): string {
  return (
    "I couldn't finish this request because this turn reached its step limit. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}
