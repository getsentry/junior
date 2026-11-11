import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  automationListSchema,
  conversationDetailReportSchema,
  reviewItemCountSchema,
  reviewItemListSchema,
  reviewItemSchema,
  reviewItemWaitingConversationsSchema,
  type ReviewItemActionBody,
} from "@sentry/junior/api/schema";

import { conversationDetailTitle } from "../format";
import { fetchDashboardJson, post } from "../http";

/** Prefix of every Review item read, for refreshes after a change. */
export const REVIEW_ITEMS_QUERY_KEY = ["dashboard", "review-items"] as const;

/**
 * List the open Review items that the viewer can see, one page at a time.
 * `items` holds the items of every loaded page, and `query` loads more.
 * `forViewer` drops the items that are assigned only to other people.
 * `closed` lists the done and dismissed items instead, newest closed first.
 */
export function useReviewItemsData(filters: {
  closed?: boolean;
  conversationId?: string;
  enabled?: boolean;
  forViewer?: boolean;
}) {
  const params = new URLSearchParams();
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.forViewer) params.set("for", "viewer");
  if (filters.closed) params.set("status", "done,dismissed");
  const search = params.toString();
  const query = useInfiniteQuery({
    enabled: filters.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryKey: [...REVIEW_ITEMS_QUERY_KEY, "list", search],
    queryFn: ({ pageParam, signal }) => {
      const pageParams = new URLSearchParams(search);
      if (pageParam) pageParams.set("cursor", pageParam);
      return fetchDashboardJson(
        reviewItemListSchema,
        `/api/review-items?${pageParams.toString()}`,
        signal,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pages = query.data?.pages;
  const items = useMemo(
    () => (pages ?? []).flatMap((page) => page.items),
    [pages],
  );
  return { items, query };
}

/** Read one Review item, for a link to an item outside the current list. */
export function useReviewItemData(id: string | undefined) {
  return useQuery({
    enabled: Boolean(id),
    queryKey: [...REVIEW_ITEMS_QUERY_KEY, "detail", id],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(id!)}`,
        signal,
      ),
    retry: false,
  });
}

/**
 * Read the titles of the Conversations linked to an item. Each read asks for
 * one event only. A Conversation that the viewer cannot read has no title.
 */
export function useLinkedConversationTitles(
  conversationIds: readonly string[],
): (string | undefined)[] {
  return useQueries({
    queries: conversationIds.map((conversationId) => ({
      queryKey: ["dashboard", "conversation-title", conversationId],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        conversationDetailTitle(
          await fetchDashboardJson(
            conversationDetailReportSchema,
            `/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
            signal,
          ),
        ) ?? null,
      retry: false,
      staleTime: 5 * 60_000,
    })),
  }).map((query) => query.data ?? undefined);
}

/**
 * Count the open action items assigned to the viewer, for the nav. The
 * versions poll refreshes it when it changes.
 */
export function useReviewItemCountData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: [...REVIEW_ITEMS_QUERY_KEY, "count"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemCountSchema,
        "/api/review-items/count",
        signal,
      ),
    retry: false,
  });
}

/**
 * The viewer's Automations that need attention: blocked, a trigger that is
 * unavailable, or a last run that failed or blocked. The Automation list
 * computes it; there is no Review item for it.
 */
export function useAutomationAttentionData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "automations", "scope=attention&owner=me"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationListSchema,
        "/api/automations?scope=attention&owner=me&pageSize=100",
        signal,
      ),
    retry: false,
  });
}

/** Take, submit, or dismiss one Review item. */
export function useReviewItemAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { body: ReviewItemActionBody; id: string }) =>
      post(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(args.id)}/actions`,
        args.body,
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: REVIEW_ITEMS_QUERY_KEY }),
  });
}

/**
 * Open Review items, newest first, that one Conversation waits on the viewer
 * for, and when the wait began (the oldest item).
 */
export type WaitingConversation = {
  items: Array<{ plugin?: string; title: string }>;
  waitingSince: string;
};

const NO_WAITING: ReadonlyMap<string, WaitingConversation> = new Map();

const waitingConversationsQuery = {
  queryKey: [...REVIEW_ITEMS_QUERY_KEY, "waiting-conversations"],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    fetchDashboardJson(
      reviewItemWaitingConversationsSchema,
      "/api/review-items/waiting-conversations",
      signal,
    ),
  retry: false,
};

/**
 * Return the Conversations that wait on the viewer, by Conversation id: each
 * has a linked open action item assigned to the viewer. An agent's action
 * asks a question; a plugin's action asks for a step such as a merge.
 */
export function useWaitingConversations(): ReadonlyMap<
  string,
  WaitingConversation
> {
  const query = useQuery(waitingConversationsQuery);
  const conversations = query.data?.conversations;
  return useMemo(
    () =>
      conversations
        ? new Map(
            conversations.map(({ conversationId, items, waitingSince }) => [
              conversationId,
              { items, waitingSince },
            ]),
          )
        : NO_WAITING,
    [conversations],
  );
}
