import { useEffect, useRef } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";

import {
  conversationDetailQueryKey,
  conversationDetailQueryOptions,
  readConversationData,
  type ConversationSnapshot,
} from "./queries";
import { refreshSideReadsOnChange } from "./conversationSideReads";
import { readConversationStartPosition } from "./transcriptReadPosition";

// Long enough that a pointer moving across the list fetches nothing.
const HOVER_INTENT_MS = 150;

/**
 * Fetch the detail as the open of the Conversation would: with the mailbox
 * and the unread page, and with no cached copy to compare. The next visit
 * uses this fetch as its open fetch. A failed fetch resolves too: the open
 * then fetches again.
 */
export async function prefetchConversationDetail(
  client: QueryClient,
  conversationId: string,
): Promise<void> {
  const query = client.getQueryCache().find({
    exact: true,
    queryKey: conversationDetailQueryKey(conversationId),
  });
  // An open Conversation polls by itself.
  if (query?.getObserversCount()) return;
  await client.prefetchQuery({
    ...conversationDetailQueryOptions(conversationId),
    queryFn: async ({ signal }): Promise<ConversationSnapshot> => {
      const next = await readConversationData(
        conversationId,
        signal,
        undefined,
        {
          mailbox: true,
          unreadPage: readConversationStartPosition() === "unread",
        },
      );
      // The open fetch compares with this ETag, so it cannot see the change.
      refreshSideReadsOnChange(
        client,
        conversationId,
        client.getQueryData(conversationDetailQueryKey(conversationId)),
        next,
      );
      return { ...next, prefetchedAtMs: Date.now() };
    },
  });
}

/**
 * Prefetch a Conversation when the pointer rests on its list row or the row
 * gets focus, so the open can show it at once.
 */
export function usePrefetchConversation(conversationId: string) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void prefetchConversationDetail(queryClient, conversationId),
      HOVER_INTENT_MS,
    );
  };
  const cancel = () => clearTimeout(timer.current);
  return {
    onBlur: cancel,
    onFocus: start,
    // A tap opens the row at once, so a touch gives no time to prefetch.
    onPointerEnter: (event: { pointerType: string }) => {
      if (event.pointerType !== "touch") start();
    },
    onPointerLeave: cancel,
  };
}
