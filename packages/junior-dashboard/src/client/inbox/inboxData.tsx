import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { conversationDisplayState } from "../conversations/ConversationStateIcon";
import { pinnedFirst } from "../conversations/conversationSections";
import { useInboxConversations } from "../conversations/useInboxConversations";
import type { Conversation } from "../types";
import { foldNotices, fyiRows, viewRows, type InboxView } from "./inboxModel";
import { inboxCounts } from "./inboxCounts";
import { waitingPullRequestCount } from "./InboxPullRequests";
import { useLinkedInboxItems } from "./inboxListState";
import { useInboxSnoozes } from "./inboxSnoozes";
import {
  useClosingInboxItemIds,
  useLinkedConversationTitles,
  useInboxItemData,
  useInboxItemStates,
  useInboxItemsData,
} from "./queries";
import { useInboxCountData, scrollPages } from "./inboxQueries";
import {
  inboxBundles,
  itemUpForGrabs,
  type InboxBundle,
} from "./inboxItemFormat";
import { useInboxSweep } from "./useInboxSweep";

/** A Conversation row, with what it asks of the viewer when it asks. */
export type ConversationRow = {
  bundle?: InboxBundle;
  conversation?: Conversation;
  conversationId: string;
  time: string;
};

const activityAt = (conversation: Conversation) =>
  conversation.lastMessageAt ?? conversation.lastProgressAt;

const IN_FLIGHT_LIMIT = 5;

// Asks from Conversations outside the loaded feed, such as an Automation
// run, take their place by time among the unpinned rows. Appended, they
// would sit below every loaded Conversation, however new they are.
function withRowsByTime(
  feedRows: ConversationRow[],
  rows: ConversationRow[],
): ConversationRow[] {
  const pending = [...rows].sort(
    (left, right) => Date.parse(right.time) - Date.parse(left.time),
  );
  const merged: ConversationRow[] = [];
  for (const row of feedRows) {
    if (!row.conversation?.pinnedAt) {
      while (pending[0] && Date.parse(pending[0].time) > Date.parse(row.time))
        merged.push(pending.shift()!);
    }
    merged.push(row);
  }
  return [...merged, ...pending];
}

/** What the Inbox sidebar and its lists read: one value for both. */
type InboxData = ReturnType<typeof useBuildInboxData>;

const InboxDataContext = createContext<InboxData | null>(null);

/** The pages after the loaded ones, for infinite scroll. */
export type InboxFeedPages = {
  /** The last page failed. Loading stops until `retry` succeeds. */
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
};

function useBuildInboxData(input: {
  conversations: Conversation[];
  feed: InboxFeedPages;
  /** The asks need a signed-in viewer. Without one, only Conversations show. */
  signedIn: boolean;
}) {
  const { conversations, feed, signedIn } = input;
  // To do shows the first page even while collapsed, and the waiting sort
  // puts what needs the viewer on it.
  const { items: loaded, query: itemsQuery } = useInboxItemsData({
    enabled: signedIn,
    forViewer: true,
    sort: "waiting",
  });
  // Snoozed reads its rows from the server, like To do. It reads every
  // page, so its rows match its count. Only the Inbox list shows them, so
  // the read waits until a list mounts; the counts read on their own.
  const [snoozedWanted, setSnoozedWanted] = useState(false);
  const readSnoozed = useCallback(() => setSnoozedWanted(true), []);
  const { items: snoozedItems, query: snoozedQuery } = useInboxItemsData({
    enabled: signedIn && snoozedWanted,
    forViewer: true,
    snoozed: true,
  });
  const {
    fetchNextPage: fetchNextSnoozed,
    hasNextPage: moreSnoozed,
    isError: snoozedFailed,
    isFetching: fetchingSnoozed,
    isPending: snoozedPending,
  } = snoozedQuery;
  useEffect(() => {
    if (moreSnoozed && !fetchingSnoozed && !snoozedFailed) {
      void fetchNextSnoozed();
    }
  }, [fetchNextSnoozed, fetchingSnoozed, moreSnoozed, snoozedFailed]);
  const snoozedLoaded = !snoozedPending && !snoozedFailed && !moreSnoozed;
  const snoozedItemIds = useMemo(
    () =>
      snoozedLoaded ? new Set(snoozedItems.map((item) => item.id)) : undefined,
    [snoozedItems, snoozedLoaded],
  );
  const snoozes = useInboxSnoozes({
    failed: snoozedFailed,
    itemIds: snoozedItemIds,
    itemsUpdatedAtMs: snoozedQuery.dataUpdatedAt,
    listUpdatedAtMs: itemsQuery.dataUpdatedAt,
  });
  // A link can name an open item past the loaded page. It joins the list
  // for the session, so a tab switch or a remount keeps its row.
  const [linkedItems, setLinkedItems] = useLinkedInboxItems();
  const linkedId = linkedItems.open;
  const linked = useInboxItemData(linkedId).data;
  const includeItem = useCallback(
    (id: string) => setLinkedItems((current) => ({ ...current, open: id })),
    [setLinkedItems],
  );
  // The items of the open Inbox row, as the list last showed them. When a
  // read shows one closed, as when an agent or a Watch closes it, it stays
  // until its card leaves as it does on Dismiss: the list then stops
  // holding it.
  const [openRow, setOpenRow] = useState<readonly InboxItemPayload[]>([]);
  const holdOpenRow = useCallback(
    (items: readonly InboxItemPayload[]) =>
      setOpenRow((current) =>
        current.length === items.length &&
        current.every((item, index) => item === items[index])
          ? current
          : items,
      ),
    [],
  );
  // A card that left stops being held, so the list drops it.
  const releaseHeld = useCallback(
    (id: string) =>
      setOpenRow((current) => current.filter((item) => item.id !== id)),
    [],
  );
  // The items of rows that leave, held until their motion ends, by id.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, InboxItemPayload>>(
    () => new Map(),
  );
  const holdLeaving = useCallback(
    (items: readonly InboxItemPayload[], held: boolean) =>
      setLeaving((current) => {
        const next = new Map(current);
        for (const item of items) {
          if (held) next.set(item.id, item);
          else next.delete(item.id);
        }
        return next;
      }),
    [],
  );
  // The viewer's actions in flight already took their items out. A read
  // that the server answered before an action lands has them still open.
  const closing = useClosingInboxItemIds();
  // The server leaves snoozed items out of `loaded`, so a linked item joins
  // only once the snoozes show that none hides it.
  const linkedAwake =
    linked?.status === "open" && snoozes.hidesItem(linked.id) === false;
  const read = useMemo(() => {
    const open = loaded.filter((item) => !closing.has(item.id));
    return linkedAwake &&
      linked &&
      !closing.has(linked.id) &&
      !open.some((item) => item.id === linked.id)
      ? [...open, linked]
      : open;
  }, [closing, linked, linkedAwake, loaded]);
  // The kept item is extra while no loaded page holds it: only the link
  // keeps it in the list.
  const includedExtra =
    linked !== undefined && !loaded.some((item) => item.id === linked.id);
  // Before the first read, no item has left it. The viewer's own actions
  // did not close an item elsewhere.
  const missing = useMemo(
    () =>
      itemsQuery.data
        ? openRow.filter(
            (item) =>
              !read.some((open) => open.id === item.id) &&
              !closing.has(item.id) &&
              !leaving.has(item.id),
          )
        : [],
    [closing, itemsQuery.data, leaving, openRow, read],
  );
  // An item can leave the loaded pages and still be open, so each one's
  // own read says whether it closed. Until then, it stays.
  const states = useInboxItemStates(missing.map((item) => item.id));
  const closedElsewhere = useMemo(
    () => missing.filter((_item, index) => states[index] === "closed"),
    [missing, states],
  );
  const list = useMemo(() => {
    const held = missing.flatMap((item, index) => {
      const state = states[index] ?? "pending";
      return state === "pending" || state === "closed" ? [item] : [state];
    });
    const shown = new Set([...read, ...held].map((item) => item.id));
    const left = [...leaving.values()].filter((item) => !shown.has(item.id));
    return held.length > 0 || left.length > 0
      ? [...read, ...held, ...left]
      : read;
  }, [leaving, missing, read, states]);
  // The server counts what waits on the viewer past the loaded pages. To do
  // pages on its own reads, so a count that is pending or failed cannot
  // stop it.
  const serverCounts = useInboxCountData(signedIn).data;
  const nowMs = Date.now();
  const sweeper = useInboxSweep();

  const conversationById = useMemo(
    () => new Map(conversations.map((c) => [c.id, c])),
    [conversations],
  );
  // Items can come from Conversations outside the loaded feed, such as an
  // Automation run. Those titles load on their own.
  const missingIds = useMemo(
    () => [
      ...new Set(
        list.flatMap((item) =>
          item.rootConversationId &&
          !conversationById.has(item.rootConversationId)
            ? [item.rootConversationId]
            : [],
        ),
      ),
    ],
    [conversationById, list],
  );
  const missingTitles = useLinkedConversationTitles(missingIds);
  // An item that no Conversation owns has no Conversation title.
  const titleOf = (id: string | undefined) =>
    id === undefined
      ? undefined
      : (conversationById.get(id)?.displayTitle ??
        missingTitles[missingIds.indexOf(id)]);

  // The server leaves snoozed rows out of `list` and lists them in Snoozed.
  // A notice about the subject of an ask shows on that ask's row instead,
  // and sleeps and wakes with it, so both lists fold together.
  const snoozedIds = new Set(snoozedItems.map((item) => item.id));
  const { folded: foldedNotices, shown } = foldNotices(
    [
      ...new Map(
        [...list, ...snoozedItems].map((item) => [item.id, item]),
      ).values(),
    ].filter((item) => !sweeper.isSwept(item.id)),
  );
  // A row snoozed a moment ago stays out until the list refreshes.
  const awake = shown.filter(
    (item) => !snoozedIds.has(item.id) && !snoozes.hides(item),
  );
  // One pin: the Conversation's own. A sweep leaves a pinned Conversation.
  const isPinned = (conversationId: string | undefined) =>
    Boolean(conversationId && conversationById.get(conversationId)?.pinnedAt);

  // To do holds the asks that name the viewer. Asks for Everyone are up for
  // grabs, and notices are FYI.
  const todoRowsOf = (items: readonly InboxItemPayload[]) =>
    inboxBundles(
      items.filter((item) => item.kind === "action" && !itemUpForGrabs(item)),
    ).filter((bundle) => bundle.needsYou);
  const asks = awake.filter((item) => item.kind === "action");
  const todoRows = todoRowsOf(awake);
  const grabRows = inboxBundles(asks.filter(itemUpForGrabs));
  // An item woken a moment ago leaves Snoozed before the list refreshes.
  const snoozedRows = inboxBundles(
    shown.filter((item) => snoozedIds.has(item.id) && !snoozes.waking(item.id)),
  );

  // Every Conversation, pinned first in the viewer's order, then newest
  // activity, with its items. A Conversation outside the loaded feed joins
  // when it has open items. Items that no Conversation owns are in no
  // Conversation row.
  const rowsByTime = (all: InboxBundle[]) => {
    const bundles = all.flatMap((bundle) =>
      bundle.conversationId
        ? [{ ...bundle, conversationId: bundle.conversationId }]
        : [],
    );
    const bundleByConversation = new Map(
      bundles.map((bundle) => [bundle.conversationId, bundle]),
    );
    return withRowsByTime(
      pinnedFirst(conversations).map((conversation): ConversationRow => ({
        bundle: bundleByConversation.get(conversation.id),
        conversation,
        conversationId: conversation.id,
        time: activityAt(conversation),
      })),
      bundles
        .filter((bundle) => !conversationById.has(bundle.conversationId))
        .map((bundle): ConversationRow => ({
          bundle,
          conversationId: bundle.conversationId,
          time: bundle.newest.createdAt,
        })),
    );
  };
  const conversationRows = rowsByTime(inboxBundles(awake));

  // In flight: every pin and every busy Conversation, whose tree waits on
  // the viewer, works, or watches for an Event or Timer. Busy rows come
  // first, a busy pin with them, then the other pins in the viewer's order.
  // Collapsed, every pin shows, each one click away, and busy Conversations
  // fill the rows left, up to IN_FLIGHT_LIMIT.
  const pinned = pinnedFirst(
    conversations.filter((conversation) => conversation.pinnedAt),
  );
  const busy = (conversation: Conversation) => {
    const state = conversationDisplayState(conversation);
    return state !== undefined && state !== "pinned";
  };
  const busyRows = conversations.filter(
    (conversation) => busy(conversation) && !conversation.pinnedAt,
  );
  const inFlightFor = (unpinnedBusy: Conversation[]) => [
    ...unpinnedBusy,
    ...pinned.filter(busy),
    ...pinned.filter((conversation) => !busy(conversation)),
  ];

  // Each badge counts its page's rows (`inboxCounts`). A row that leaves
  // after a read shows its items closed counts no more.
  const onPage = closedElsewhere.length
    ? awake.filter((item) => !closedElsewhere.includes(item))
    : awake;
  const known = closedElsewhere.length
    ? list.filter((item) => !closedElsewhere.includes(item))
    : list;
  const pageCounts = inboxCounts({
    hasMore: itemsQuery.hasNextPage,
    known,
    loaded: itemsQuery.data ? loaded : undefined,
    rows: {
      decisions: viewRows(onPage, "decisions").length,
      prs: waitingPullRequestCount(viewRows(onPage, "prs")),
      // A stack shows a row for each of its items.
      todo: todoRowsOf(onPage).reduce(
        (rows, row) => rows + row.items.length,
        0,
      ),
    },
    server: serverCounts,
  });
  // Snoozed and Automations count on the server. Done has no count: it
  // would need every closed item.
  const counts: Partial<Record<InboxView | "automations", number>> = {
    automations: serverCounts?.automations,
    decisions: pageCounts.decisions,
    inbox: pageCounts.todo,
    prs: pageCounts.prs,
    snoozed: serverCounts?.snoozed,
  };

  return {
    awake,
    /** The open row's items, held after a read shows them closed. */
    closedElsewhere,
    conversationById,
    conversationRows,
    counts,
    feed,
    /** The notices that fold into each ask's row, by the ask's id. */
    foldedNotices,
    fyiRows: fyiRows(awake),
    /** Keep a row's items while it leaves, after a read drops them. */
    holdLeaving,
    holdOpenRow,
    includedId: linkedId,
    includedExtra,
    includeItem,
    /** Every in-flight Conversation, in pane order. */
    inFlight: inFlightFor(busyRows),
    /** Collapsed In flight: every pin, and busy rows up to the limit. */
    inFlightCollapsed: inFlightFor(
      busyRows.slice(0, Math.max(0, IN_FLIGHT_LIMIT - pinned.length)),
    ),
    isPinned,
    // The open asks load a page at a time too, as the list scrolls.
    itemPages: scrollPages(itemsQuery),
    itemsError: Boolean(itemsQuery.error && !itemsQuery.data),
    // Signed out, there are no asks to wait for.
    itemsLoaded: !signedIn || Boolean(itemsQuery.data),
    nowMs,
    /** Every pin, in the viewer's stored order. */
    pinned,
    releaseHeld,
    signedIn,
    snoozedRows,
    /** Start reading Snoozed; the Inbox list calls it when it mounts. */
    readSnoozed,
    snoozedRead: {
      failed: snoozedFailed,
      /** Every page is read, so an empty list means nothing is snoozed. */
      loaded: snoozedLoaded,
      loading: fetchingSnoozed,
      /** Loaded with no read in flight, so a missing row is not snoozed. */
      settled:
        !snoozedPending && !snoozedFailed && !moreSnoozed && !fetchingSnoozed,
      // A later page retries that page, and keeps the rows already read.
      retry: () =>
        void (moreSnoozed ? fetchNextSnoozed() : snoozedQuery.refetch()),
    },
    snoozes,
    sweeper,
    titleOf,
    /** To do's count, the same as its badge, or undefined until known. */
    todoCount: pageCounts.todo,
    todoRows,
    grabRows,
  };
}

/**
 * Load and shape what the pane and the Inbox lists show: the open asks,
 * the Automations that need attention, snoozes, sweeps, and the
 * Conversations they belong to. The shell provides it once, so the pane on
 * every page, the phone navigation, and the lists read one value: a count
 * always matches its list, and a sweep shows in all at once.
 */
export function InboxDataProvider(props: {
  children: ReactNode;
  signedIn: boolean;
}) {
  const { conversations, feed } = useInboxConversations();
  const value = useBuildInboxData({
    conversations,
    // A failed feed page waits for Try again, as the other lists do. A list
    // end can still ask for more after the failure renders.
    feed: scrollPages({
      fetchNextPage: () => void feed.fetchNextPage({ cancelRefetch: false }),
      hasNextPage: feed.hasNextPage,
      isFetchNextPageError: feed.isFetchNextPageError,
      isFetchingNextPage: feed.isFetchingNextPage,
    }),
    signedIn: props.signedIn,
  });
  return (
    <InboxDataContext.Provider value={value}>
      {props.children}
    </InboxDataContext.Provider>
  );
}

/** Read the Inbox data inside `InboxDataProvider`. */
export function useInboxData(): InboxData {
  const value = useContext(InboxDataContext);
  if (!value) throw new Error("The Inbox requires InboxDataProvider");
  return value;
}
