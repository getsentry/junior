import { useMemo, useRef } from "react";
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
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { conversationDetailTitle } from "../format";
import { fetchDashboardJson, post } from "../http";

/** Prefix of every Review item read, for refreshes after a change. */
export const REVIEW_ITEMS_QUERY_KEY = ["dashboard", "review-items"] as const;

type ReviewItemListFilters = {
  /** Lists the done and dismissed items instead, newest closed first. */
  closed?: boolean;
  conversationId?: string;
  enabled?: boolean;
  forViewer?: boolean;
  q?: string;
};

function reviewItemListSearch(filters: ReviewItemListFilters) {
  const params = new URLSearchParams();
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.forViewer) params.set("for", "viewer");
  if (filters.q) params.set("q", filters.q);
  if (filters.closed) params.set("status", "done,dismissed");
  return params.toString();
}

/** Key the Review item list that these filters read. */
export function reviewItemListQueryKey(filters: ReviewItemListFilters) {
  return [...REVIEW_ITEMS_QUERY_KEY, "list", reviewItemListSearch(filters)];
}

/**
 * List the open Review items that the viewer can see, one page at a time.
 * `items` holds the items of every loaded page, and `query` loads more.
 * `forViewer` drops the items that are assigned only to other people.
 * `closed` lists the done and dismissed items instead. `q` matches title
 * and body text; the first page then also holds closed matches.
 */
export function useReviewItemsData(filters: ReviewItemListFilters) {
  const search = reviewItemListSearch(filters);
  const query = useInfiniteQuery({
    enabled: filters.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryKey: reviewItemListQueryKey(filters),
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

/**
 * Read one Review item, for a link to an item outside the current list.
 * `placeholder` shows until the read finishes.
 */
export function useReviewItemData(
  id: string | undefined,
  placeholder?: ReviewItemPayload,
) {
  return useQuery({
    enabled: Boolean(id),
    placeholderData: placeholder,
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
 * Read one Review item that a Conversation's transcript shows. An item in
 * the Conversation's list comes from there, so it refreshes with the list
 * and needs no read of its own. The list holds only open items, so a
 * closed item, or one on a later page, loads by itself.
 */
export function useConversationReviewItemData(
  conversationId: string,
  id: string,
) {
  const { items, query } = useReviewItemsData({ conversationId });
  const listed = items.find((item) => item.id === id);
  // An item that closes leaves the list. Its row keeps the listed item
  // until its own read finishes, so the row does not blank.
  const lastListed = useRef(listed);
  if (listed) lastListed.current = listed;
  // Wait for this Conversation's list before reading the item by itself.
  const waiting = query.isPending || query.isPlaceholderData;
  const direct = useReviewItemData(
    listed || waiting ? undefined : id,
    lastListed.current,
  );
  return listed
    ? { data: listed, isError: false }
    : { data: direct.data, isError: direct.isError };
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
    // The row of an item that this closes reads it by itself, so it starts
    // from the answer.
    onSuccess: (item) =>
      queryClient.setQueryData(
        [...REVIEW_ITEMS_QUERY_KEY, "detail", item.id],
        item,
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
