/** Build a stable turn identifier from a message ID. */
export function buildDeterministicTurnId(messageId: string): string {
  const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `turn_${sanitized}`;
}

/** Build the stable visible assistant-message identity for one logical turn. */
export function buildDeterministicAssistantMessageId(turnId: string): string {
  return `${turnId}:assistant:1`;
}
