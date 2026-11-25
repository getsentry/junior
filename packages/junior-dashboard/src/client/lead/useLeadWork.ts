import { useMemo } from "react";

import { useConversationsData } from "../api";
import { buildConversations } from "../format";
import {
  useWaitingConversations,
  useWaitingConversationsSettled,
} from "../inbox/queries";
import { useSpaceConversationsData } from "../spaces/queries";
import type { Conversation } from "../types";

/**
 * Read the Conversations that a Space's Lead shows: each row of the Space
 * and of the viewer's feed by id, and the open Inbox items that wait on the
 * viewer. The Lead starts work in its Space, and can watch a Conversation of
 * the viewer outside it. `waiting` is undefined until it loads, so no row
 * reads as Failed or Done before it can read as Needs you.
 */
export function useLeadWork(spaceId: string | undefined) {
  const feed = useConversationsData();
  const spaceFeed = useSpaceConversationsData(spaceId);
  const waitingMap = useWaitingConversations();
  const waiting = useWaitingConversationsSettled() ? waitingMap : undefined;
  const rows = feed.data?.conversations;
  const spaceRows = spaceFeed.data?.conversations;
  return useMemo(
    () => ({
      byId: new Map<string, Conversation>(
        buildConversations([...(rows ?? []), ...(spaceRows ?? [])]).map(
          (conversation) => [conversation.id, conversation],
        ),
      ),
      waiting,
    }),
    [rows, spaceRows, waiting],
  );
}
