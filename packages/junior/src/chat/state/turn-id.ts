/** Build a stable turn identifier from a message ID. */
export function buildDeterministicTurnId(messageId: string): string {
  const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `turn_${sanitized}`;
}

/** Build the stable visible assistant-message identity for one logical turn. */
export function buildDeterministicAssistantMessageId(turnId: string): string {
  return `${turnId}:assistant:1`;
}

/** Return whether a stored message is an assistant reply of the Turn. */
export function isTurnReply(
  message: {
    id: string;
    meta?: { turnId?: unknown } | undefined;
    role: string;
  },
  turnId: string,
): boolean {
  if (message.role !== "assistant") return false;
  const stored = message.meta?.turnId;
  if (typeof stored === "string") return stored === turnId;
  return legacyAssistantMessageTurnId(message.id) === turnId;
}

// Assistant messages saved before `meta.turnId` carry their Turn only in the
// id. Keep this until no Turn that started before then can still resume,
// retry, or report.
function legacyAssistantMessageTurnId(messageId: string): string | undefined {
  const index = messageId.lastIndexOf(":assistant:");
  return index > 0 ? messageId.slice(0, index) : undefined;
}
