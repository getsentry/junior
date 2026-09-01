import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";

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

/** Count tool calls on assistant messages in one turn history. */
export function countTurnToolCalls(messages: readonly PiMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!isAssistantMessage(message)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "toolCall") {
        count += 1;
      }
    }
  }
  return count;
}

/** Stop the turn when its tool-call count is already above the limit. */
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
