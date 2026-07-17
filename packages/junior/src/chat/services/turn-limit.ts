/** Terminal failure raised when one agent turn exhausts its slice budget. */
export class TurnSliceLimitExceededError extends Error {
  constructor(maxSlices: number) {
    super(`Agent turn exceeded execution limit (${maxSlices} slices)`);
    this.name = "TurnSliceLimitExceededError";
  }
}

/** Explain a terminal turn execution limit with actionable recovery guidance. */
export function buildTurnLimitResponse(eventId: string): string {
  return (
    "I couldn't finish this request because this turn reached its execution limit. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}
