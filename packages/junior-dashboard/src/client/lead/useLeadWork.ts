import { useMemo } from "react";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import { useWaitingConversations } from "../inbox/queries";
import type { Conversation } from "../types";

/**
 * Read the viewer's Conversations for the Lead: each feed row by id, and the
 * open Inbox items that wait on the viewer.
 */
export function useLeadWork() {
  const feed = useConversationsData();
  const waiting = useWaitingConversations();
  const rows = feed.data?.conversations;
  return useMemo(
    () => ({
      byId: new Map<string, Conversation>(
        buildConversations(rows ?? []).map((conversation) => [
          conversation.id,
          conversation,
        ]),
      ),
      waiting,
    }),
    [rows, waiting],
  );
}
