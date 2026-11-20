import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { renameConversationResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import { withoutVersion } from "../revalidation";
import { patchFeedConversation } from "./conversationArchive";
import {
  mapConversationFeedCache,
  type ConversationFeedCache,
} from "./conversationFeedCache";
import { conversationDetailQueryKey } from "./queries";

type DetailCache = ConversationDetailReport & { detailEtag?: string };

/**
 * Rename one conversation for every viewer. The feed and detail caches show
 * the new title at once. A failed request puts the old caches back.
 */
export function useRenameConversation(
  conversationId: string,
  options?: { onError?(): void },
) {
  const queryClient = useQueryClient();
  const feeds = { queryKey: ["dashboard", "conversations"] };
  const detailQueryKey = conversationDetailQueryKey(conversationId);
  const setTitle = (displayTitle: string) => {
    queryClient.setQueriesData<ConversationFeedCache>(feeds, (feed) =>
      feed
        ? mapConversationFeedCache(feed, (conversations) =>
            patchFeedConversation(conversations, conversationId, {
              displayTitle,
            }),
          )
        : feed,
    );
    queryClient.setQueryData<DetailCache>(detailQueryKey, (detail) =>
      detail
        ? withoutVersion({ ...detail, displayTitle }, "detailEtag")
        : detail,
    );
  };
  return useMutation({
    mutationFn: (title: string) =>
      patch(
        renameConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/title`,
        { title },
      ),
    onMutate: async (title) => {
      await Promise.all([
        queryClient.cancelQueries(feeds),
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
      ]);
      const previous = {
        detail: queryClient.getQueryData<DetailCache>(detailQueryKey),
        feeds: queryClient.getQueriesData<ConversationFeedCache>(feeds),
      };
      setTitle(title);
      return previous;
    },
    onError: (_error, _title, previous) => {
      for (const [queryKey, feed] of previous?.feeds ?? []) {
        queryClient.setQueryData(queryKey, feed);
      }
      queryClient.setQueryData(detailQueryKey, previous?.detail);
      options?.onError?.();
    },
    // The answer's title is in every feed, so no feed refetches. The
    // versions poll refreshes the feeds if another change moved them.
    onSuccess: (result) => setTitle(result.title),
    onSettled: () =>
      queryClient.invalidateQueries({
        exact: true,
        queryKey: detailQueryKey,
      }),
  });
}
