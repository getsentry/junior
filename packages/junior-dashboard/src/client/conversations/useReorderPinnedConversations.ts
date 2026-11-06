import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useReducer } from "react";
import type { ConversationFeed } from "@sentry/junior/api/schema";
import { reorderPinnedConversationsResponseSchema } from "@sentry/junior/api/schema";

import { put } from "../http";

const PIN_ORDER_MUTATION_KEY = ["dashboard", "pin-order"];
const feeds = { queryKey: ["dashboard", "conversations"] };

/** One drop: the full Pinned order after it, and what to do if it fails. */
export type PinOrderMove = {
  conversationIds: string[];
  onError(): void;
};

/** Save a new Pinned order for the viewer. */
export type ReorderPins = (move: PinOrderMove) => void;

/**
 * Return a function that saves the viewer's Pinned order. The feed caches
 * take the new order in the same call, before any request, so a dropped row
 * stays where it lands. Saves run one at a time, so the server gets drops in
 * order. After the last save, the feeds refetch the saved order.
 *
 * Call it in the component that reads the feed. The cache tells React about
 * the new order only in a later task, so the old order would show for one
 * frame. A state change renders the caller in the drop's frame, and the
 * caller then reads the new order from the cache.
 */
export function useReorderPinnedConversations(): ReorderPins {
  const queryClient = useQueryClient();
  const [, renderDrop] = useReducer((count: number) => count + 1, 0);
  const { mutate } = useMutation({
    mutationKey: PIN_ORDER_MUTATION_KEY,
    scope: { id: "pin-order" },
    mutationFn: ({ conversationIds }: PinOrderMove) =>
      put(
        reorderPinnedConversationsResponseSchema,
        "/api/conversations/pin-order",
        { conversationIds },
      ),
    onError: (_error, move) => move.onError(),
    // A later queued drop owns the cache, so only the last save refetches.
    onSettled: () =>
      queryClient.isMutating({ mutationKey: PIN_ORDER_MUTATION_KEY }) === 1
        ? queryClient.invalidateQueries(feeds)
        : undefined,
  });
  return useCallback(
    (move: PinOrderMove) => {
      // Drop feed reads in flight, so they cannot write the old order.
      void queryClient.cancelQueries(feeds);
      setPinPositions(queryClient, move.conversationIds);
      renderDrop();
      mutate(move);
    },
    [mutate, queryClient],
  );
}

/**
 * Report whether a Pinned order save is pending. A feed read that ends before
 * the save would show the old order, so the feed waits.
 */
export function usePinOrderSaving(): boolean {
  return useIsMutating({ mutationKey: PIN_ORDER_MUTATION_KEY }) > 0;
}

function setPinPositions(queryClient: QueryClient, conversationIds: string[]) {
  const positions = new Map(conversationIds.map((id, index) => [id, index]));
  queryClient.setQueriesData<ConversationFeed>(feeds, (feed) =>
    feed
      ? {
          ...feed,
          conversations: feed.conversations.map((conversation) => {
            const pinPosition = positions.get(conversation.conversationId);
            return pinPosition === undefined
              ? conversation
              : { ...conversation, pinPosition };
          }),
        }
      : feed,
  );
}
