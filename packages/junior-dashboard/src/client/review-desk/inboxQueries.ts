import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  automationListSchema,
  reviewItemCountSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import pLimit from "p-limit";

import { automationKeys } from "../api";
import { fetchDashboardJson } from "../http";
import { useSnoozedItemIds } from "./inboxSnooze";
import { REVIEW_ITEMS_QUERY_KEY } from "./queries";

// The new UI's reads for the Inbox count and the Automations that need
// attention. The current UI does not load them.

const REVIEW_ITEM_COUNT_QUERY_KEY = [...REVIEW_ITEMS_QUERY_KEY, "count"];
const ATTENTION_PAGE_READS = 8;

/**
 * Count, on the server, the open action items assigned to the viewer, by
 * bundle, and the open snoozed rows. Snoozed and Automations show it as it
 * is. To do, Decisions, and Pull requests use it only for the items past
 * the loaded pages (`inboxCounts`). The versions poll refreshes it when it
 * changes.
 */
export function useInboxCountData(enabled: boolean) {
  // The snoozed rows live in this browser; the server counts the open ones.
  const snoozed = useSnoozedItemIds().join(",");
  return useQuery({
    enabled,
    placeholderData: keepPreviousData,
    queryKey: [...REVIEW_ITEM_COUNT_QUERY_KEY, snoozed],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemCountSchema,
        `/api/review-items/count?${new URLSearchParams({
          include: "automations",
          ...(snoozed ? { snoozed } : undefined),
        })}`,
        signal,
      ),
    retry: false,
  });
}

/**
 * Refresh the reads that one Automation change can affect: every list, the
 * runs list, which shows titles, and the Inbox count, which counts the
 * Automations that need attention.
 */
function invalidateAutomationListReads(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: automationKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: automationKeys.runs() }),
    queryClient.invalidateQueries({ queryKey: REVIEW_ITEM_COUNT_QUERY_KEY }),
  ]);
}

/**
 * Refresh reads after one Automation changes. The change returns the new
 * edit read, so that read is written, not fetched again.
 */
export function refreshChangedAutomation(
  queryClient: QueryClient,
  updated: AutomationEdit,
) {
  queryClient.setQueryData(automationKeys.edit(updated.id), updated);
  return Promise.all([
    invalidateAutomationListReads(queryClient),
    queryClient.invalidateQueries({
      queryKey: automationKeys.one(updated.id),
      // The edit read is already current.
      predicate: (query) => query.queryKey.at(-1) !== "edit",
    }),
  ]);
}

/** Refresh reads after one Automation is deleted, and drop its own reads. */
export function refreshDeletedAutomation(queryClient: QueryClient, id: string) {
  queryClient.removeQueries({ queryKey: automationKeys.one(id) });
  return invalidateAutomationListReads(queryClient);
}

/**
 * Turn an infinite query into the pages a list loads as it scrolls: whether
 * there is a next page, and a way to load it.
 */
export function scrollPages(query: {
  fetchNextPage(): void;
  hasNextPage: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
}) {
  return {
    // A failed page waits for a retry, so it does not load again in a loop.
    failed: query.isFetchNextPageError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (
        query.hasNextPage &&
        !query.isFetchingNextPage &&
        !query.isFetchNextPageError
      )
        query.fetchNextPage();
    },
    retry: () => query.fetchNextPage(),
  };
}

/**
 * The viewer's Automations that need attention: blocked, a trigger that is
 * unavailable, or a last run that failed or blocked. The Automation list
 * computes it; there is no Review item for it.
 */
export function useAutomationAttentionData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: [...automationKeys.lists(), "scope=attention&owner=me"],
    // The Inbox count is not capped, so read every page: the list then
    // shows each Automation that the count counts.
    queryFn: async ({ signal }) => {
      const readPage = (page: number) =>
        fetchDashboardJson(
          automationListSchema,
          `/api/automations?scope=attention&owner=me&pageSize=100&page=${page}`,
          signal,
        );
      const first = await readPage(1);
      const pageCount = Math.ceil(first.total / first.pageSize);
      // Read the other pages at the same time, at most a few at once.
      const limit = pLimit(ATTENTION_PAGE_READS);
      const rest = await Promise.all(
        Array.from({ length: Math.max(pageCount - 1, 0) }, (_, index) =>
          limit(() => readPage(index + 2)),
        ),
      );
      return {
        ...first,
        automations: [first, ...rest].flatMap((page) => page.automations),
      };
    },
    retry: false,
  });
}
