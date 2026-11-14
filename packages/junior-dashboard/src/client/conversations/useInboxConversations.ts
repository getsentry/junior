import { useMemo } from "react";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import type { Conversation } from "../types";
import {
  usePendingArchiveConversationUpdates,
  withoutThreads,
  type PendingArchiveConversationUpdate,
} from "./conversationArchive";

/**
 * Read the Conversation feed as the Inbox shows it, with archives that are
 * still pending already applied. Older feed pages load only when a list
 * scrolls to its end. The feed query keeps every loaded page, so Back
 * restores every row.
 */
export function useInboxConversations() {
  const feed = useConversationsData();
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
      ),
    [feed.data?.conversations, pendingArchiveUpdates],
  );
  return { conversations, feed, pendingArchiveUpdates };
}

function applyPendingArchiveUpdates(
  conversations: Conversation[],
  updates: PendingArchiveConversationUpdate[],
): Conversation[] {
  // The optimistic cache write in useArchiveConversation sets archivedAt on
  // success too, ahead of the feed invalidation settling. Drop already-
  // archived rows here so they cannot reappear until the mutation leaves
  // "pending" but the stale cache has not refetched yet.
  const byId = new Map(
    conversations
      .filter((conversation) => !conversation.archivedAt)
      .map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
    if (update.archived) {
      byId.delete(update.conversationId);
      continue;
    }
    const existing = byId.get(update.conversationId);
    const conversation =
      existing ??
      (update.conversation
        ? buildConversations([update.conversation])[0]
        : undefined);
    if (!conversation) continue;
    byId.set(update.conversationId, { ...conversation, archivedAt: null });
  }
  const rows = [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
  // A refetch can bring back a Thread whose archive is still pending.
  const archivedIds = new Set(
    updates
      .filter((update) => update.archived)
      .map((update) => update.conversationId),
  );
  // Keep row identity when nothing is pending, so memoized rows skip renders.
  return archivedIds.size === 0
    ? rows
    : withoutThreads(rows, (thread) => archivedIds.has(thread.id));
}
