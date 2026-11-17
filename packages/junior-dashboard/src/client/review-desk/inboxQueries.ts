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
import { useAutomationAlerts } from "./automationAlerts";
import { REVIEW_ITEMS_QUERY_KEY } from "./queries";

// The new UI's reads for the Inbox count and the Automations that need
// attention. The current UI does not load them.

const REVIEW_ITEM_COUNT_QUERY_KEY = [...REVIEW_ITEMS_QUERY_KEY, "count"];
const ATTENTION_PAGE_READS = 8;

/**
 * Count To do: the asks and the Automations that wait on the viewer, as the
 * server counts them. The Inbox tab badge, the browser tab and To do read
 * this one hook, so they always match.
 */
export function useInboxTodoCount(enabled: boolean): number | undefined {
  const count = useInboxCountData(enabled).data;
  const attention = useAutomationAttentionData(enabled);
  const alerts = useAutomationAlerts(Date.now());
  if (!count) return undefined;
  // The count read always sends `include=automations,snoozed`.
  const automations = count.automations ?? 0;
  // Alerts put away in this browser leave To do, so they leave its count.
  // Only the attention list says which Automations they are. Until it
  // loads, show no count: a count that drops after load marks a false
  // update on a pinned tab. A failed list cannot say, so all count.
  if (automations > 0 && alerts.anyPutAway && !attention.data)
    return attention.error ? count.needsViewer + automations : undefined;
  const putAway = attention.data?.automations.filter(alerts.hidden).length ?? 0;
  return count.needsViewer + Math.max(0, automations - putAway);
}

/**
 * Count what the Inbox entries and the badge show, as the server counts it:
 * the open action items assigned to the viewer, by bundle, and the snoozed
 * rows. The versions poll refreshes it when it changes.
 */
export function useInboxCountData(enabled: boolean) {
  return useQuery({
    enabled,
    placeholderData: keepPreviousData,
    queryKey: REVIEW_ITEM_COUNT_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemCountSchema,
        "/api/review-items/count?include=automations,snoozed",
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
