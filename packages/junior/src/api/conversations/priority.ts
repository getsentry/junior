/** Conversations with no known work leave Priority after this idle window. */
export const UNASSIGNED_PRIORITY_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Unfinished work leaves Priority after this idle window. */
export const UNFINISHED_PRIORITY_WINDOW_MS = 48 * 60 * 60 * 1000;

export type ConversationPriorityInput = {
  assignedWork?: boolean;
  finishedWorkAt?: string;
  lastSeenAt: string;
  lastUserMessageAt?: string;
  unfinishedWork?: boolean;
};

/**
 * Decide whether a conversation belongs in the dashboard Priority section.
 *
 * Priority includes only:
 * - unfinished work last seen within 48 hours
 * - finished assigned work with a user message after the finish time
 * - no known work last seen within 3 hours
 *
 * Finished assigned work with no later activity stays out of Priority.
 */
export function isConversationPriority(
  conversation: ConversationPriorityInput,
  nowMs: number,
): boolean {
  const lastSeenAt = Date.parse(conversation.lastSeenAt);
  if (!Number.isFinite(lastSeenAt)) return false;

  if (conversation.unfinishedWork) {
    return nowMs - lastSeenAt <= UNFINISHED_PRIORITY_WINDOW_MS;
  }

  if (conversation.assignedWork) {
    const finishedAt = Date.parse(conversation.finishedWorkAt ?? "");
    const lastUserMessageAt = Date.parse(conversation.lastUserMessageAt ?? "");
    return (
      Number.isFinite(finishedAt) &&
      Number.isFinite(lastUserMessageAt) &&
      lastUserMessageAt > finishedAt
    );
  }

  return nowMs - lastSeenAt <= UNASSIGNED_PRIORITY_WINDOW_MS;
}
