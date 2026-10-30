import type { ConversationWorkState, InboundMessage } from "./store";

function selectContiguousTurnBatch(
  messages: readonly InboundMessage[],
): InboundMessage[] {
  const first = messages[0];
  if (!first) {
    return [];
  }
  const nextTurnIndex = messages.findIndex(
    (message) =>
      message.input.authorId !== first.input.authorId ||
      message.source !== first.source,
  );
  return messages.slice(
    0,
    nextTurnIndex === -1 ? messages.length : nextTurnIndex,
  );
}

/**
 * True when an interrupt can start its own attempt.
 *
 * A steered web message must not start a second Turn while a yielded Turn
 * waits to resume. It stays pending for that Turn's drain or the next attempt.
 */
export function isAttemptInterrupt(
  message: InboundMessage,
  work: ConversationWorkState,
): boolean {
  return (
    message.delivery === "interrupt" &&
    !(work.execution.status === "paused" && message.source === "web")
  );
}

/** Prioritize interrupts while keeping each attempt to one Actor and Source. */
export function selectAttemptMessages(
  work: ConversationWorkState,
): InboundMessage[] {
  const messages = work.messages;
  const interrupts = messages.filter((message) =>
    isAttemptInterrupt(message, work),
  );
  if (interrupts.length > 0) {
    return selectContiguousTurnBatch(interrupts);
  }
  if (work.execution.status === "paused") return [];
  const nonEventMessages = messages.filter(
    (message) => message.source !== "event",
  );
  return selectContiguousTurnBatch(
    nonEventMessages.length > 0 ? nonEventMessages : messages,
  );
}
