import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";

/** Terminal failure when one agent turn exhausts a hard execution budget. */
export class TurnExecutionLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnExecutionLimitExceededError";
  }
}

/** Terminal failure raised when one agent turn exhausts its slice budget. */
export class TurnSliceLimitExceededError extends TurnExecutionLimitExceededError {
  constructor(maxSlices: number) {
    super(`Agent turn exceeded execution limit (${maxSlices} slices)`);
    this.name = "TurnSliceLimitExceededError";
  }
}

/** Terminal failure raised when one agent turn exhausts its tool-call budget. */
export class TurnToolCallLimitExceededError extends TurnExecutionLimitExceededError {
  constructor(maxToolCalls: number) {
    super(`Agent turn exceeded execution limit (${maxToolCalls} tool calls)`);
    this.name = "TurnToolCallLimitExceededError";
  }
}

/** Count tool calls already present in one turn's committed/resumed messages. */
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

/**
 * Fail closed when committed turn tool calls exceed the budget.
 * Callers that already include the pending assistant message in
 * `existingToolCalls` should pass `pendingToolCalls: 0`.
 */
export function assertTurnToolCallBudget(args: {
  existingToolCalls: number;
  maxToolCalls: number;
  pendingToolCalls?: number;
}): void {
  const pendingToolCalls = args.pendingToolCalls ?? 0;
  if (args.existingToolCalls + pendingToolCalls <= args.maxToolCalls) {
    return;
  }
  throw new TurnToolCallLimitExceededError(args.maxToolCalls);
}

/** Explain a terminal turn execution limit with actionable recovery guidance. */
export function buildTurnLimitResponse(eventId: string): string {
  return (
    "I couldn't finish this request because this turn reached its execution limit. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}
