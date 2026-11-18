import { useMemo, useRef } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type Mutation,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  automationListSchema,
  conversationDetailReportSchema,
  reviewItemActionSchema,
  reviewItemCountSchema,
  reviewItemListSchema,
  reviewItemSchema,
  reviewItemWaitingConversationsSchema,
  type ReviewItemActionBody,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";
import * as z from "zod";

import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import { conversationDetailTitle } from "../format";
import { DashboardApiError, fetchDashboardJson, post } from "../http";
import { automationKeys } from "../api";
import { itemNeedsViewer } from "./reviewItemFormat";

type ReviewItemCount = z.output<typeof reviewItemCountSchema>;
type ReviewItemList = z.output<typeof reviewItemListSchema>;

/** Prefix of every Review item read, for refreshes after a change. */
export const REVIEW_ITEMS_QUERY_KEY = ["dashboard", "review-items"] as const;

type ReviewItemListFilters = {
  /** Lists the done and dismissed items instead, newest closed first. */
  closed?: boolean;
  conversationId?: string;
  enabled?: boolean;
  forViewer?: boolean;
  q?: string;
  /**
   * `waiting` pages the open items that wait on the viewer first, so the
   * first page holds what needs them now.
   */
  sort?: "waiting";
};

function reviewItemListSearch(filters: ReviewItemListFilters) {
  const params = new URLSearchParams();
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.forViewer) params.set("for", "viewer");
  if (filters.q) params.set("q", filters.q);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.closed) params.set("status", "done,dismissed");
  return params.toString();
}

/** Key one Review item. Each Review item row reads its own item. */
export function reviewItemQueryKey(id: string | undefined) {
  return [...REVIEW_ITEMS_QUERY_KEY, "detail", id];
}

const REVIEW_ITEM_COLLECTIONS = [
  "count",
  "list",
  "waiting-conversations",
] as const;

/**
 * Refresh the Review item reads that a change to known items moves: the
 * count, the lists, and the waiting Conversations. Write each changed item
 * to its own key, so the rows of the other items do not refetch.
 */
export function invalidateReviewItemCollections(queryClient: QueryClient) {
  return Promise.all(
    REVIEW_ITEM_COLLECTIONS.map((collection) =>
      queryClient.invalidateQueries({
        queryKey: [...REVIEW_ITEMS_QUERY_KEY, collection],
      }),
    ),
  );
}

/** Key the Review item list that these filters read. */
export function reviewItemListQueryKey(filters: ReviewItemListFilters) {
  return [...REVIEW_ITEMS_QUERY_KEY, "list", reviewItemListSearch(filters)];
}

/**
 * List the open Review items that the viewer can see, one page at a time.
 * A search also finds archived items, with the first page. `items` holds the
 * items of every loaded page, and `query` loads more. `forViewer` drops the
 * items that are assigned only to other people.
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
  return { items, moreArchived: Boolean(pages?.[0]?.moreArchived), query };
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
    ...reviewItemQuery(id),
    enabled: Boolean(id),
    placeholderData: placeholder,
  });
}

/** Read the saved copy of one Review item, such as an action's result. */
export function useSavedReviewItem(id: string): ReviewItemPayload | undefined {
  return useQuery({ ...reviewItemQuery(id), enabled: false }).data;
}

function reviewItemQuery(id: string | undefined) {
  return {
    queryKey: reviewItemQueryKey(id),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchDashboardJson(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(id!)}`,
        signal,
      ),
    retry: false,
  };
}

/** What one item's own read says now, or `pending` while it reads. */
type ReviewItemState = ReviewItemPayload | "closed" | "pending";

function reviewItemStates(
  reads: {
    data?: ReviewItemPayload;
    error: Error | null;
    isFetching: boolean;
  }[],
): ReviewItemState[] {
  return reads.map((read) => {
    if (read.isFetching) return "pending";
    if (read.data) return read.data.status === "open" ? read.data : "closed";
    // A missing item is gone. Another failure says nothing.
    return read.error instanceof DashboardApiError && read.error.status === 404
      ? "closed"
      : "pending";
  });
}

/**
 * Read each item again by itself when the caller first asks about it,
 * and say whether it is open, closed, or still reading. A list read holds
 * only its loaded pages, so an item that leaves it may still be open.
 */
export function useReviewItemStates(ids: readonly string[]): ReviewItemState[] {
  return useQueries({
    queries: ids.map((id) => ({
      ...reviewItemQuery(id),
      refetchOnMount: "always" as const,
    })),
    combine: reviewItemStates,
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
  // An item that closes leaves the list, and a list read that starts again,
  // such as Try again after a failed page, turns the item read off. The row
  // keeps the last item until a read finishes, so it does not blank.
  const lastShown = useRef(listed);
  // Wait for this Conversation's list before reading the item by itself.
  const waiting = query.isPending || query.isPlaceholderData;
  const direct = useReviewItemData(
    listed || waiting ? undefined : id,
    lastShown.current,
  );
  const data =
    listed ?? direct.data ?? (waiting ? lastShown.current : undefined);
  if (data) lastShown.current = data;
  return { data, isError: listed ? false : direct.isError };
}

/**
 * Read the titles of the Conversations linked to an item. Each read asks for
 * one event only. A Conversation that the viewer cannot read has no title.
 */
export function useLinkedConversationTitles(
  conversationIds: readonly string[],
): (string | undefined)[] {
  const queryClient = useQueryClient();
  return useQueries({
    queries: conversationIds.map((conversationId) => ({
      queryKey: ["dashboard", "conversation-title", conversationId],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        // An open Conversation reads its full detail. Take the title from
        // that read, cached or in flight, and do not read it a second time.
        const detailKey = conversationDetailQueryKey(conversationId);
        const cached =
          queryClient.getQueryData<ConversationSnapshot>(detailKey);
        if (cached) return conversationDetailTitle(cached) ?? null;
        if (queryClient.getQueryState(detailKey)?.fetchStatus === "fetching") {
          return (
            conversationDetailTitle(
              await queryClient.fetchQuery<ConversationSnapshot>({
                queryKey: detailKey,
              }),
            ) ?? null
          );
        }
        return (
          conversationDetailTitle(
            await fetchDashboardJson(
              conversationDetailReportSchema,
              `/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
              signal,
            ),
          ) ?? null
        );
      },
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
 * List the viewer's blocked Automations. They show on the review desk, but
 * their state stays derived from Automation status.
 */
export function useBlockedAutomationsData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: [...automationKeys.lists(), "scope=mine&state=blocked"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationListSchema,
        "/api/automations?scope=mine&state=blocked&pageSize=100",
        signal,
      ),
    retry: false,
  });
}

const REVIEW_ITEM_ACTION_KEY = [...REVIEW_ITEMS_QUERY_KEY, "action"];

const reviewItemActionVariablesSchema = z.object({
  body: reviewItemActionSchema,
  id: z.string(),
});

/** One action on one Review item, as `useReviewItemAction` sends it. */
type ReviewItemAction = z.output<typeof reviewItemActionVariablesSchema>;

/** The action that a mutation of `useReviewItemAction` sends. */
function actionOf(mutation: Mutation<unknown, Error, unknown, unknown>) {
  const parsed = reviewItemActionVariablesSchema.safeParse(
    mutation.state.variables,
  );
  return parsed.success ? parsed.data : undefined;
}

function closesItem(body: ReviewItemActionBody): boolean {
  return body.action !== "take";
}

type ReviewItemListCache = InfiniteData<ReviewItemList, string | undefined>;

/** Where one item showed in each open list, so it can go back there. */
type ItemPlaces = {
  item: ReviewItemPayload;
  places: { index: number; page: number; queryKey: QueryKey }[];
};

// Lists of closed items, and searches, which also show closed items, keep
// an item that closes.
function listsOpenItems(queryKey: QueryKey): boolean {
  const search = new URLSearchParams(String(queryKey.at(-1) ?? ""));
  return !search.has("status") && !search.has("q");
}

function changeCounts(
  queryClient: QueryClient,
  item: ReviewItemPayload,
  by: number,
) {
  if (!itemNeedsViewer(item)) return;
  queryClient.setQueriesData<ReviewItemCount>(
    { queryKey: [...REVIEW_ITEMS_QUERY_KEY, "count"] },
    (count) =>
      count && {
        ...count,
        codeChanges: Math.max(
          0,
          count.codeChanges +
            (item.subject?.objectType === "code_change" ? by : 0),
        ),
        decisions: Math.max(0, count.decisions + (item.request ? by : 0)),
        needsViewer: Math.max(0, count.needsViewer + by),
      },
  );
}

/**
 * Take an item that closes out of every open list and the counts at once.
 * Return where it was, to put it back if the action fails.
 */
async function takeOutClosedItem(
  queryClient: QueryClient,
  id: string,
): Promise<ItemPlaces | undefined> {
  const lists = { queryKey: [...REVIEW_ITEMS_QUERY_KEY, "list"] };
  const counts = { queryKey: [...REVIEW_ITEMS_QUERY_KEY, "count"] };
  // A read in flight would write the item back.
  await Promise.all([
    queryClient.cancelQueries(lists),
    queryClient.cancelQueries(counts),
  ]);
  let item: ReviewItemPayload | undefined;
  const places: ItemPlaces["places"] = [];
  for (const [
    queryKey,
    list,
  ] of queryClient.getQueriesData<ReviewItemListCache>(lists)) {
    if (!list || !listsOpenItems(queryKey)) continue;
    const found = places.length;
    for (const [page, { items }] of list.pages.entries()) {
      const index = items.findIndex((open) => open.id === id);
      if (index < 0) continue;
      item = items[index];
      places.push({ index, page, queryKey });
    }
    if (places.length === found) continue;
    queryClient.setQueryData<ReviewItemListCache>(queryKey, {
      ...list,
      pages: list.pages.map((page) => ({
        ...page,
        items: page.items.filter((open) => open.id !== id),
      })),
    });
  }
  if (!item) return undefined;
  changeCounts(queryClient, item, -1);
  return { item, places };
}

/**
 * Put a failed action's item back where it was. Only this item changes,
 * so the other actions in flight keep their own changes.
 */
function putBackItem(queryClient: QueryClient, { item, places }: ItemPlaces) {
  // A read that already shows the item again also counted it.
  let restored = false;
  for (const place of places) {
    queryClient.setQueryData<ReviewItemListCache>(place.queryKey, (list) => {
      if (
        !list ||
        list.pages.some((page) =>
          page.items.some((open) => open.id === item.id),
        )
      )
        return list;
      restored = true;
      return {
        ...list,
        pages: list.pages.map((page, index) =>
          index === place.page
            ? {
                ...page,
                items: [
                  ...page.items.slice(0, place.index),
                  item,
                  ...page.items.slice(place.index),
                ],
              }
            : page,
        ),
      };
    });
  }
  if (restored) changeCounts(queryClient, item, 1);
}

/** How many Review item actions are in flight. */
export function reviewItemActionsInFlight(queryClient: QueryClient): number {
  return queryClient.isMutating({ mutationKey: REVIEW_ITEM_ACTION_KEY });
}

/**
 * Take, submit, or dismiss one Review item. `optimistic` takes an item that
 * closes out of the lists and counts before the server answers, and puts it
 * back in its place if the action fails. Each action settles by itself, and
 * the lists read again after the last one in flight.
 */
export function useReviewItemAction(options: { optimistic?: boolean } = {}) {
  const queryClient = useQueryClient();
  const { optimistic = false } = options;
  return useMutation({
    mutationKey: REVIEW_ITEM_ACTION_KEY,
    mutationFn: (args: ReviewItemAction) =>
      post(
        reviewItemSchema,
        `/api/review-items/${encodeURIComponent(args.id)}/actions`,
        args.body,
      ),
    onMutate: (args) =>
      optimistic && closesItem(args.body)
        ? takeOutClosedItem(queryClient, args.id)
        : undefined,
    onError: (_error, args, places) => {
      if (places) putBackItem(queryClient, places);
      return queryClient.invalidateQueries({
        exact: true,
        queryKey: reviewItemQueryKey(args.id),
      });
    },
    // The row of an item that this closes reads it by itself, so it starts
    // from the answer.
    onSuccess: (item) =>
      queryClient.setQueryData(reviewItemQueryKey(item.id), item),
    // A read while another action is in flight would show its item again.
    onSettled: () =>
      reviewItemActionsInFlight(queryClient) === 1
        ? invalidateReviewItemCollections(queryClient)
        : undefined,
  });
}

/** The ids of the items that an action in flight closes. */
export function useClosingReviewItemIds(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: REVIEW_ITEM_ACTION_KEY, status: "pending" },
    select: (mutation) => {
      const action = actionOf(mutation);
      return action && closesItem(action.body) ? action.id : "";
    },
  });
  const key = ids.filter(Boolean).sort().join("\n");
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/**
 * The answer of the viewer's last action on an item, when that action was
 * an answer that failed, so the form shows it again.
 */
export function useFailedReviewItemAnswer(id: string) {
  const actions = useMutationState({
    filters: { mutationKey: REVIEW_ITEM_ACTION_KEY },
    select: (mutation) => {
      const action = actionOf(mutation);
      return action?.id === id
        ? { body: action.body, failed: mutation.state.status === "error" }
        : undefined;
    },
  });
  // The mutation cache keeps insertion order, so the last one is newest.
  const last = actions.filter(Boolean).at(-1);
  return last?.failed && last.body.action === "submit"
    ? last.body.answer
    : undefined;
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

/** Whether the first read of the waiting Conversations has finished. */
export function useWaitingConversationsSettled(): boolean {
  return !useQuery(waitingConversationsQuery).isPending;
}

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
