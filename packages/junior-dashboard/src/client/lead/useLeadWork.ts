import { useMemo } from "react";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import { useSpaceConversationsData } from "../spaces/queries";
import type { Conversation } from "../types";

/**
 * Read the Conversations that a Space's Lead shows, by id: each row of the
 * Space and of the viewer's feed. The Lead starts work in its Space, and
 * can watch a Conversation of the viewer outside it.
 */
export function useLeadWork(spaceId: string | undefined) {
  const feed = useConversationsData();
  const spaceFeed = useSpaceConversationsData(spaceId);
  const rows = feed.data?.conversations;
  const spaceRows = spaceFeed.data?.conversations;
  return useMemo(
    () => ({
      byId: new Map<string, Conversation>(
        buildConversations([...(rows ?? []), ...(spaceRows ?? [])]).map(
          (conversation) => [conversation.id, conversation],
        ),
      ),
    }),
    [rows, spaceRows],
  );
}
