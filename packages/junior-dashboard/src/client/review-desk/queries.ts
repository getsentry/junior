import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  automationListSchema,
  reviewItemCountSchema,
  reviewItemListSchema,
  reviewItemSchema,
  type ReviewItemActionBody,
} from "@sentry/junior/api/schema";

import { fetchDashboardJson, post } from "../http";

/** Review desk views. Each shows open items, or archived ones. */
export const REVIEW_DESK_VIEWS = ["mine", "everyone", "all"] as const;
export type ReviewDeskView = (typeof REVIEW_DESK_VIEWS)[number];

const REVIEW_ITEMS_QUERY_KEY = ["dashboard", "review-items"] as const;
const COUNT_REFRESH_MS = 60_000;

/** List the Review items that the viewer can see in one view. */
export function useReviewItemsData(filters: {
  archived: boolean;
  conversationId?: string;
  q?: string;
  view: ReviewDeskView;
}) {
  const params = new URLSearchParams({ view: filters.view });
  if (filters.archived) params.set("archived", "true");
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.q) params.set("q", filters.q);
  const search = params.toString();
  return useQuery({
    queryKey: [...REVIEW_ITEMS_QUERY_KEY, "list", search],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        reviewItemListSchema,
        `/api/review-items?${search}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
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

/** Count the open Review items assigned to the viewer, for the nav. */
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
