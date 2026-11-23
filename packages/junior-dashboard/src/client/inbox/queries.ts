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
  answeredChoices,
  conversationDetailReportSchema,
  inboxItemActionSchema,
  inboxItemCountSchema,
  inboxItemListSchema,
  inboxItemSchema,
  inboxItemWaitingConversationsSchema,
  type InboxItemActionBody,
  type InboxItemPayload,
} from "@sentry/junior/api/schema";
import * as z from "zod";

import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import { clearAnswerDraft } from "../components/answerDrafts";
import {
  mapConversationFeedCache,
  type ConversationFeedCache,
} from "../conversations/conversationFeedCache";
import { conversationDetailTitle } from "../format";
import { DashboardApiError, fetchDashboardJson, post } from "../http";
import {
  revalidatedJsonQuery,
  revalidatedPageQuery,
  withoutVersion,
  type ContentVersioned,
} from "../revalidation";
import { itemConversationId, itemNeedsViewer } from "./inboxItemFormat";

type InboxItemCount = z.output<typeof inboxItemCountSchema>;
type InboxItemList = z.output<typeof inboxItemListSchema>;

/** Prefix of every Inbox item read, for refreshes after a change. */
export const INBOX_ITEMS_QUERY_KEY = ["dashboard", "inbox-items"] as const;

type InboxItemListFilters = {
  /** Only Automation alerts. */
  automationAlerts?: boolean;
  /** Lists the done and dismissed items instead, newest closed first. */
  closed?: boolean;
  conversationId?: string;
  enabled?: boolean;
  forViewer?: boolean;
  q?: string;
  /** Only the items in Inbox rows that the viewer snoozed: Snoozed. */
  snoozed?: boolean;
  /**
   * `waiting` pages the open items that wait on the viewer first, so the
   * first page holds what needs them now.
   */
  sort?: "waiting";
};

function inboxItemListSearch(filters: InboxItemListFilters) {
  const params = new URLSearchParams();
  if (filters.conversationId) {
    params.set("conversationId", filters.conversationId);
  }
  if (filters.forViewer) params.set("for", "viewer");
  if (filters.automationAlerts) params.set("owner", "automation");
  if (filters.q) params.set("q", filters.q);
  if (filters.snoozed) params.set("snoozed", "true");
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.closed) params.set("status", "done,dismissed");
  return params.toString();
}

/** Key one Inbox item. Each Inbox item row reads its own item. */
export function inboxItemQueryKey(id: string | undefined) {
  return [...INBOX_ITEMS_QUERY_KEY, "detail", id];
}

const INBOX_ITEM_COLLECTIONS = [
  "count",
  "list",
  "waiting-conversations",
] as const;

/**
 * Refresh the Inbox item reads that a change to known items moves: the
 * count, the lists, and the waiting Conversations. Write each changed item
 * to its own key, so the rows of the other items do not refetch.
 */
export function invalidateInboxItemCollections(queryClient: QueryClient) {
  return Promise.all(
    INBOX_ITEM_COLLECTIONS.map((collection) =>
      queryClient.invalidateQueries({
        queryKey: [...INBOX_ITEMS_QUERY_KEY, collection],
      }),
    ),
  );
}

/** Key the Inbox item list that these filters read. */
export function inboxItemListQueryKey(filters: InboxItemListFilters) {
  return [...INBOX_ITEMS_QUERY_KEY, "list", inboxItemListSearch(filters)];
}

/**
 * Refresh the Inbox item lists that show an item that one Conversation
 * added. The item's subject card reads that Conversation's detail, so a
 * change there, such as a merged pull request, can come with a change to
 * the item. Only mounted lists refetch.
 */
export function invalidateInboxItemListsOfConversation(
  queryClient: QueryClient,
  conversationId: string,
) {
  const lists = [...INBOX_ITEMS_QUERY_KEY, "list"];
  // Each list key ends with the search of its filters.
  const searches = new Set(
    queryClient
      .getQueriesData<InboxItemListCache>({ queryKey: lists })
      .filter(([, list]) =>
        list?.pages?.some((page) =>
          page.items.some(
            (item) => itemConversationId(item) === conversationId,
          ),
        ),
      )
      .map(([queryKey]) => queryKey.at(-1)),
  );
  return queryClient.invalidateQueries({
    predicate: (query) => searches.has(query.queryKey.at(-1)),
    queryKey: lists,
  });
}

/**
 * List the open Inbox items that the viewer can see, one page at a time.
 * A search also finds archived items, with the first page. `items` holds the
 * items of every loaded page, and `query` loads more. `forViewer` drops the
 * items that are assigned only to other people.
 */
export function useInboxItemsData(filters: InboxItemListFilters) {
  const search = inboxItemListSearch(filters);
  const query = useInfiniteQuery({
    enabled: filters.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryKey: inboxItemListQueryKey(filters),
    queryFn: revalidatedPageQuery(inboxItemListSchema, (pageParam) => {
      const pageParams = new URLSearchParams(search);
      if (pageParam) pageParams.set("cursor", pageParam);
      return `/api/inbox-items?${pageParams.toString()}`;
    }),
    getNextPageParam: (lastPage: InboxItemList) => lastPage.nextCursor,
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
 * Read one Inbox item, for a link to an item outside the current list.
 * `placeholder` shows until the read finishes.
 */
export function useInboxItemData(
  id: string | undefined,
  placeholder?: InboxItemPayload,
) {
  return useQuery({
    ...inboxItemQuery(id),
    enabled: Boolean(id),
    placeholderData: placeholder,
  });
}

function inboxItemQuery(id: string | undefined) {
  return {
    queryKey: inboxItemQueryKey(id),
    queryFn: revalidatedJsonQuery(
      inboxItemSchema,
      `/api/inbox-items/${encodeURIComponent(id!)}`,
    ),
    retry: false,
  };
}

/** What one item's own read says now, or `pending` while it reads. */
type InboxItemState = InboxItemPayload | "closed" | "pending";

function inboxItemStates(
  reads: {
    data?: InboxItemPayload;
    error: Error | null;
    isFetching: boolean;
  }[],
): InboxItemState[] {
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
export function useInboxItemStates(ids: readonly string[]): InboxItemState[] {
  return useQueries({
    queries: ids.map((id) => ({
      ...inboxItemQuery(id),
      refetchOnMount: "always" as const,
    })),
    combine: inboxItemStates,
  });
}

/**
 * Read one Inbox item that a Conversation's transcript shows. An item in
 * the Conversation's list comes from there, so it refreshes with the list
 * and needs no read of its own. The list holds only open items, so a
 * closed item, or one on a later page, loads by itself.
 */
export function useConversationInboxItemData(
  conversationId: string,
  id: string,
) {
  const { items, query } = useInboxItemsData({ conversationId });
  const listed = items.find((item) => item.id === id);
  // An item that closes leaves the list, and a list read that starts again,
  // such as Try again after a failed page, turns the item read off. The row
  // keeps the last item until a read finishes, so it does not blank.
  const lastShown = useRef(listed);
  // Wait for this Conversation's list before reading the item by itself.
  const waiting = query.isPending || query.isPlaceholderData;
  const direct = useInboxItemData(
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
export function useInboxItemCountData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: [...INBOX_ITEMS_QUERY_KEY, "count"],
    queryFn: revalidatedJsonQuery(
      inboxItemCountSchema,
      "/api/inbox-items/count",
    ),
    retry: false,
  });
}

const INBOX_ITEM_ACTION_KEY = [...INBOX_ITEMS_QUERY_KEY, "action"];

const inboxItemActionVariablesSchema = z.object({
  body: inboxItemActionSchema,
  id: z.string(),
});

/** One action on one Inbox item, as `useInboxItemAction` sends it. */
type InboxItemAction = z.output<typeof inboxItemActionVariablesSchema>;

/** The action that a mutation of `useInboxItemAction` sends. */
function actionOf(mutation: Mutation<unknown, Error, unknown, unknown>) {
  const parsed = inboxItemActionVariablesSchema.safeParse(
    mutation.state.variables,
  );
  return parsed.success ? parsed.data : undefined;
}

function closesItem(body: InboxItemActionBody): boolean {
  return body.action !== "take";
}

type InboxItemListCache = InfiniteData<
  ContentVersioned<InboxItemList>,
  string | undefined
>;

/** Where one item showed in each open list, so it can go back there. */
type ItemPlaces = {
  item: InboxItemPayload;
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
  item: InboxItemPayload,
  by: number,
) {
  if (!itemNeedsViewer(item)) return;
  queryClient.setQueriesData<ContentVersioned<InboxItemCount>>(
    { queryKey: [...INBOX_ITEMS_QUERY_KEY, "count"] },
    (count) =>
      count &&
      withoutVersion(
        {
          ...count,
          codeChanges: Math.max(
            0,
            count.codeChanges +
              (item.subject?.objectType === "code_change" ? by : 0),
          ),
          decisions: Math.max(0, count.decisions + (item.request ? by : 0)),
          needsViewer: Math.max(0, count.needsViewer + by),
        },
        "contentVersion",
      ),
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
  const lists = { queryKey: [...INBOX_ITEMS_QUERY_KEY, "list"] };
  const counts = { queryKey: [...INBOX_ITEMS_QUERY_KEY, "count"] };
  // A read in flight would write the item back.
  await Promise.all([
    queryClient.cancelQueries(lists),
    queryClient.cancelQueries(counts),
  ]);
  let item: InboxItemPayload | undefined;
  const places: ItemPlaces["places"] = [];
  for (const [queryKey, list] of queryClient.getQueriesData<InboxItemListCache>(
    lists,
  )) {
    if (!list || !listsOpenItems(queryKey)) continue;
    const found = places.length;
    for (const [page, { items }] of list.pages.entries()) {
      const index = items.findIndex((open) => open.id === id);
      if (index < 0) continue;
      item = items[index];
      places.push({ index, page, queryKey });
    }
    if (places.length === found) continue;
    queryClient.setQueryData<InboxItemListCache>(queryKey, {
      ...list,
      pages: list.pages.map((page) =>
        page.items.some((open) => open.id === id)
          ? withoutVersion(
              {
                ...page,
                items: page.items.filter((open) => open.id !== id),
              },
              "contentVersion",
            )
          : page,
      ),
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
    queryClient.setQueryData<InboxItemListCache>(place.queryKey, (list) => {
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
            ? withoutVersion(
                {
                  ...page,
                  items: [
                    ...page.items.slice(0, place.index),
                    item,
                    ...page.items.slice(place.index),
                  ],
                },
                "contentVersion",
              )
            : page,
        ),
      };
    });
  }
  if (restored) changeCounts(queryClient, item, 1);
}

/**
 * Put the viewer's answer on its Conversation's feed rows, as the next feed
 * read sends it, so a row says "You answered Hold" at once. The feed sends
 * the answer on root rows only, so a Thread row keeps none.
 */
async function showAnswerOnFeedRows(
  queryClient: QueryClient,
  item: InboxItemPayload,
): Promise<void> {
  if (!item.answer || !item.request || !item.closedAt) return;
  const viewerAnswer = {
    choices: answeredChoices(item.request, item.answer),
    closedAt: item.closedAt,
  };
  const feeds = { queryKey: ["dashboard", "conversations"] };
  // A feed read that started before the answer would overwrite the patch. A
  // feed with no data yet keeps its first read.
  await queryClient.cancelQueries({
    ...feeds,
    predicate: (query) => query.state.data !== undefined,
  });
  queryClient.setQueriesData<ConversationFeedCache>(feeds, (feed) =>
    feed
      ? mapConversationFeedCache(feed, (conversations) =>
          conversations.map((conversation) =>
            conversation.conversationId === itemConversationId(item)
              ? { ...conversation, viewerAnswer }
              : conversation,
          ),
        )
      : feed,
  );
}

/** How many Inbox item actions are in flight. */
export function inboxItemActionsInFlight(queryClient: QueryClient): number {
  return queryClient.isMutating({ mutationKey: INBOX_ITEM_ACTION_KEY });
}

/**
 * Take, submit, or dismiss one Inbox item. `optimistic` takes an item that
 * closes out of the lists and counts before the server answers, and puts it
 * back in its place if the action fails. Each action settles by itself, and
 * the lists read again after the last one in flight.
 */
export function useInboxItemAction(options: { optimistic?: boolean } = {}) {
  const queryClient = useQueryClient();
  const { optimistic = false } = options;
  return useMutation({
    mutationKey: INBOX_ITEM_ACTION_KEY,
    mutationFn: (args: InboxItemAction) =>
      post(
        inboxItemSchema,
        `/api/inbox-items/${encodeURIComponent(args.id)}/actions`,
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
        queryKey: inboxItemQueryKey(args.id),
      });
    },
    // The row of an item that this closes reads it by itself, so it starts
    // from the answer.
    onSuccess: async (item, args) => {
      if (item.status !== "open") clearAnswerDraft(item.id);
      queryClient.setQueryData(inboxItemQueryKey(item.id), item);
      if (args.body.action === "submit")
        await showAnswerOnFeedRows(queryClient, item);
    },
    // A read while another action is in flight would show its item again.
    onSettled: () =>
      inboxItemActionsInFlight(queryClient) === 1
        ? invalidateInboxItemCollections(queryClient)
        : undefined,
  });
}

/** The ids of the items that an action in flight closes. */
export function useClosingInboxItemIds(): ReadonlySet<string> {
  const ids = useMutationState({
    filters: { mutationKey: INBOX_ITEM_ACTION_KEY, status: "pending" },
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
export function useFailedInboxItemAnswer(id: string) {
  const actions = useMutationState({
    filters: { mutationKey: INBOX_ITEM_ACTION_KEY },
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
 * Open Inbox items, newest first, that one Conversation waits on the viewer
 * for, and when the wait began (the oldest item).
 */
export type WaitingConversation = {
  items: Array<{ plugin?: string; title: string }>;
  waitingSince: string;
};

const NO_WAITING: ReadonlyMap<string, WaitingConversation> = new Map();

const waitingConversationsQuery = {
  queryKey: [...INBOX_ITEMS_QUERY_KEY, "waiting-conversations"],
  queryFn: revalidatedJsonQuery(
    inboxItemWaitingConversationsSchema,
    "/api/inbox-items/waiting-conversations",
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
