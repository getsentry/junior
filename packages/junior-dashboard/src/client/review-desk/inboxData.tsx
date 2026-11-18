import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { pinnedFirst } from "../conversations/conversationSections";
import { useInboxConversations } from "../conversations/useInboxConversations";
import type { Conversation } from "../types";
import { foldNotices, fyiRows, viewRows, type InboxView } from "./inboxModel";
import { inboxCounts } from "./inboxCounts";
import { waitingPullRequestCount } from "./InboxPullRequests";
import { useLinkedInboxItems } from "./inboxListState";
import { useAutomationAlerts } from "./automationAlerts";
import { useInboxSnoozes } from "./inboxSnoozes";
import {
  useClosingReviewItemIds,
  useLinkedConversationTitles,
  useReviewItemData,
  useReviewItemStates,
  useReviewItemsData,
} from "./queries";
import {
  useAutomationAttentionData,
  useInboxCountData,
  scrollPages,
} from "./inboxQueries";
import {
  inboxBundles,
  itemUpForGrabs,
  conversationAnswerLine,
  type InboxBundle,
} from "./reviewItemFormat";
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
  const { items: loaded, query: itemsQuery } = useReviewItemsData({
    enabled: signedIn,
    forViewer: true,
    sort: "waiting",
  });
  // Snoozed reads its rows from the server, like To do. It reads every
  // page, so its rows match its count.
  const { items: snoozedItems, query: snoozedQuery } = useReviewItemsData({
    enabled: signedIn,
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
    listUpdatedAtMs: itemsQuery.dataUpdatedAt,
  });
  // A link can name an open item past the loaded page. It joins the list
  // for the session, so a tab switch or a remount keeps its row.
  const [linkedItems, setLinkedItems] = useLinkedInboxItems();
  const linkedId = linkedItems.open;
  const linked = useReviewItemData(linkedId).data;
  const includeItem = useCallback(
    (id: string) => setLinkedItems((current) => ({ ...current, open: id })),
    [setLinkedItems],
  );
  // The items of the open Inbox row, as the list last showed them. When a
  // read shows them closed, as when an agent or a Watch closes them, they
  // stay until the row leaves as it does on Dismiss.
  const [openRow, setOpenRow] = useState<readonly ReviewItemPayload[]>([]);
  const holdOpenRow = useCallback(
    (items: readonly ReviewItemPayload[]) =>
      setOpenRow((current) =>
        current.length === items.length &&
        current.every((item, index) => item === items[index])
          ? current
          : items,
      ),
    [],
  );
  // The items of rows that leave, held until their motion ends, by id.
  const [leaving, setLeaving] = useState<
    ReadonlyMap<string, ReviewItemPayload>
  >(() => new Map());
  const holdLeaving = useCallback(
    (items: readonly ReviewItemPayload[], held: boolean) =>
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
  const closing = useClosingReviewItemIds();
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
  const states = useReviewItemStates(missing.map((item) => item.id));
  const closedElsewhere = useMemo(
    () =>
      // A row with an item still open stays, without the closed ones.
      missing.length === openRow.length &&
      states.every((state) => state === "closed")
        ? missing
        : [],
    [missing, openRow, states],
  );
  const list = useMemo(() => {
    const held = missing.flatMap((item, index) => {
      const state = states[index] ?? "pending";
      if (state === "pending") return [item];
      if (state !== "closed") return [state];
      return closedElsewhere.length > 0 ? [item] : [];
    });
    const shown = new Set([...read, ...held].map((item) => item.id));
    const left = [...leaving.values()].filter((item) => !shown.has(item.id));
    return held.length > 0 || left.length > 0
      ? [...read, ...held, ...left]
      : read;
  }, [closedElsewhere, leaving, missing, read, states]);
  // Closed items, newest closed first, as Done lists them. A Conversation
  // row says what the viewer answered until the Conversation moves on.
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const { items: closed } = useReviewItemsData({
    closed: true,
    enabled: signedIn,
    forViewer: true,
  });
  const answerOf = (conversation: Conversation): string | undefined =>
    conversationAnswerLine(closed, conversation, viewerEmail);
  const attention = useAutomationAttentionData(signedIn);
  // The server counts what waits on the viewer past the loaded pages. To do
  // pages on its own reads, so a count that is pending or failed cannot
  // stop it.
  const serverCounts = useInboxCountData(signedIn).data;
  const automations = attention.data?.automations ?? [];
  const nowMs = Date.now();
  const alerts = useAutomationAlerts(nowMs);
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
        list
          .map((item) => item.addedByConversationId)
          .filter((id) => !conversationById.has(id)),
      ),
    ],
    [conversationById, list],
  );
  const missingTitles = useLinkedConversationTitles(missingIds);
  const titleOf = (id: string) =>
    conversationById.get(id)?.displayTitle ??
    missingTitles[missingIds.indexOf(id)];

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
  const isPinned = (conversationId: string) =>
    Boolean(conversationById.get(conversationId)?.pinnedAt);

  // To do holds the asks that name the viewer. Asks for Everyone are up for
  // grabs, and notices are FYI.
  const todoRowsOf = (items: readonly ReviewItemPayload[]) =>
    inboxBundles(
      items.filter((item) => item.kind === "action" && !itemUpForGrabs(item)),
    ).filter((bundle) => bundle.needsYou);
  const asks = awake.filter((item) => item.kind === "action");
  const todoRows = todoRowsOf(awake);
  const grabRows = inboxBundles(asks.filter(itemUpForGrabs));
  const snoozedRows = inboxBundles(
    shown.filter((item) => snoozedIds.has(item.id)),
  ).filter((bundle) => !snoozes.waking(bundle.key));

  // Every Conversation, pinned first in the viewer's order, then newest
  // activity, with its items. A Conversation outside the loaded feed joins
  // when it has open items.
  const rowsByTime = (bundles: InboxBundle[]) => {
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

  // In flight: every pin and every running Conversation. Running rows come
  // first, a running pin with them, then the other pins in the viewer's
  // order. Collapsed, every pin shows, each one click away, and running
  // Conversations fill the rows left, up to IN_FLIGHT_LIMIT.
  const pinned = pinnedFirst(
    conversations.filter((conversation) => conversation.pinnedAt),
  );
  const running = conversations.filter(
    (conversation) =>
      conversation.status === "active" && !conversation.pinnedAt,
  );
  const inFlightFor = (unpinnedRunning: Conversation[]) => [
    ...unpinnedRunning,
    ...pinned.filter((conversation) => conversation.status === "active"),
    ...pinned.filter((conversation) => conversation.status !== "active"),
  ];

  const todoAutomations = automations.filter(
    (automation) => !alerts.hidden(automation),
  );
  // Each badge counts its page's rows (`inboxCounts`). A row that leaves
  // after a read shows its items closed counts no more.
  const onPage = closedElsewhere.length
    ? awake.filter((item) => !closedElsewhere.includes(item))
    : awake;
  const known = closedElsewhere.length
    ? list.filter((item) => !closedElsewhere.includes(item))
    : list;
  const pageCounts = inboxCounts({
    automationCards: automationCards(),
    hasMore: itemsQuery.hasNextPage,
    known,
    loaded: itemsQuery.data ? loaded : undefined,
    rows: {
      decisions: viewRows(onPage, "decisions").length,
      prs: waitingPullRequestCount(viewRows(onPage, "prs")),
      todo: todoRowsOf(onPage).length,
    },
    server: serverCounts,
  });
  // Alerts put away in this browser leave To do. Only the attention list
  // says which Automations they are. Until it loads, show no count: a count
  // that drops after load marks a false update on a pinned tab. A failed
  // list cannot say, so all count.
  function automationCards(): number | undefined {
    if (attention.data) return todoAutomations.length;
    if (attention.error) return serverCounts?.automations;
    if (!serverCounts) return undefined;
    const counted = serverCounts.automations ?? 0;
    return counted > 0 && alerts.anyPutAway ? undefined : counted;
  }
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
    alerts,
    /** What the viewer answered last in a Conversation, while it is news. */
    answerOf,
    automations,
    automationsError: Boolean(attention.error && !attention.data),
    /** The Automations that need attention are in, so To do is complete. */
    automationsLoaded: !signedIn || Boolean(attention.data),
    awake,
    /** The open row's items, held after a read shows them all closed. */
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
    includeItem,
    /** Every in-flight Conversation, in pane order. */
    inFlight: inFlightFor(running),
    /** Collapsed In flight: every pin, and running rows up to the limit. */
    inFlightCollapsed: inFlightFor(
      running.slice(0, Math.max(0, IN_FLIGHT_LIMIT - pinned.length)),
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
    signedIn,
    snoozedRows,
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
    /** Automation alerts for To do: those the viewer has not put away. */
    todoAutomations,
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
