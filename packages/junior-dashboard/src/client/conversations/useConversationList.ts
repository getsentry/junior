import { useMemo } from "react";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import {
  applyPendingArchiveUpdates,
  usePendingArchiveConversationUpdates,
} from "./conversationArchive";

/**
 * Read the viewer's Conversations with pending archives and restores applied.
 * An empty search is the full list the sidebar shows.
 */
export function useConversationList(search = "") {
  const feed = useConversationsData(search);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
        Boolean(search),
      ),
    [feed.data?.conversations, pendingArchiveUpdates, search],
  );
  return { conversations, feed, pendingArchiveUpdates };
}
