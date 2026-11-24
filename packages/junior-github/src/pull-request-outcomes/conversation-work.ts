import type {
  PluginCodeChanges,
  UnfinishedWorkResult,
} from "@sentry/junior-plugin-api";

/**
 * Return the work of the candidate Conversations from the Junior pull
 * requests that link to them, in one read of Junior's code index. Each
 * linked Conversation has assigned work. An open pull request is unfinished
 * work. A merged or closed one finishes, and the latest finish time of each
 * Conversation counts. A closed pull request is finished even when it did
 * not merge.
 */
export async function listGitHubConversationWork(
  codeChanges: Pick<PluginCodeChanges, "list">,
  conversationIds: string[],
): Promise<Required<UnfinishedWorkResult>> {
  if (conversationIds.length === 0) {
    return {
      assignedConversationIds: [],
      conversationIds: [],
      finishedWorkAtByConversationId: {},
    };
  }
  const candidates = new Set(conversationIds);
  const assigned = new Set<string>();
  const unfinished = new Set<string>();
  const finishedAtById = new Map<string, Date>();
  for (const change of await codeChanges.list({ conversationIds })) {
    const finishedAt =
      change.state === "open"
        ? undefined
        : (change.mergedAt ?? change.closedAt);
    for (const conversationId of change.conversationIds) {
      if (!candidates.has(conversationId)) continue;
      assigned.add(conversationId);
      if (change.state === "open") unfinished.add(conversationId);
      const current = finishedAtById.get(conversationId);
      if (finishedAt && (!current || finishedAt > current)) {
        finishedAtById.set(conversationId, finishedAt);
      }
    }
  }
  return {
    assignedConversationIds: [...assigned],
    conversationIds: [...unfinished],
    finishedWorkAtByConversationId: Object.fromEntries(
      conversationIds.flatMap((conversationId) => {
        const finishedAt = finishedAtById.get(conversationId);
        return finishedAt ? [[conversationId, finishedAt.toISOString()]] : [];
      }),
    ),
  };
}
