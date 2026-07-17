/** Terminal failure raised when one turn exhausts its continuation budget. */
export class AgentContinuationSliceLimitError extends Error {
  constructor(maxSlices: number) {
    super(`Agent continuation exceeded slice limit (${maxSlices})`);
    this.name = "AgentContinuationSliceLimitError";
  }
}

/** Explain a terminal continuation budget without exposing internal slice details. */
export function buildAgentContinuationLimitResponse(eventId: string): string {
  return (
    "I couldn't finish this request because it ran for too long. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}
