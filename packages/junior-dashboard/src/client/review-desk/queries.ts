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

const REVIEW_ITEMS_QUERY_KEY = ["dashboard", "review-items"] as const;
const COUNT_REFRESH_MS = 60_000;

/**
 * List the open Review items that the viewer can see, one page at a time.
 * A search also finds archived items, with the first page. `items` holds
 * the items of every loaded page, and `query` loads more.
 */
export function useReviewItemsData(filters: {
  conversationId?: string;
  q?: string;
}) {
  const params = new URLSearchParams();
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.q) params.set("q", filters.q);
  const search = params.toString();
  const query = useInfiniteQuery({
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
  return { items, moreArchived: Boolean(pages?.[0]?.moreArchived), query };
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

/** Count the open action items assigned to the viewer, for the nav. */
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
    refetchInterval: COUNT_REFRESH_MS,
    retry: false,
  });
}

/**
 * List the viewer's blocked Automations. They show on the review desk, but
 * their state stays derived from Automation status.
 */
export function useBlockedAutomationsData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["dashboard", "automations", "scope=mine&state=blocked"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationListSchema,
        "/api/automations?scope=mine&state=blocked&pageSize=100",
        signal,
      ),
    retry: false,
  });
}

/** Take, submit, complete, or dismiss one Review item. */
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

const NO_CONVERSATIONS: ReadonlySet<string> = new Set();

/**
 * Return the Conversations that wait on the viewer. Today only the review
 * desk sets this: a linked open action item assigned to the viewer.
 */
export function useWaitingConversationIds(): ReadonlySet<string> {
  const query = useQuery({
    queryKey: [...REVIEW_ITEMS_QUERY_KEY, "waiting-conversations"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemWaitingConversationsSchema,
        "/api/review-items/waiting-conversations",
        signal,
      ),
    refetchInterval: COUNT_REFRESH_MS,
    retry: false,
  });
  const ids = query.data?.conversationIds;
  return useMemo(() => (ids ? new Set(ids) : NO_CONVERSATIONS), [ids]);
}
