import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { pinnedFirst } from "../conversations/conversationSections";
import { useInboxConversations } from "../conversations/useInboxConversations";
import type { Conversation } from "../types";
import { foldNotices, fyiRows, type InboxView } from "./inboxModel";
import { useLinkedInboxItems } from "./inboxListState";
import { useAutomationAlerts } from "./automationAlerts";
import { useInboxSnoozes } from "./inboxSnooze";
import {
  useLinkedConversationTitles,
  useReviewItemData,
  useReviewItemStates,
  useReviewItemsData,
} from "./queries";
import {
  useAutomationAttentionData,
  useInboxTodoCount,
  useInboxCountData,
  scrollPages,
} from "./inboxQueries";
import {
  inboxBundles,
  itemUpForGrabs,
  viewerAnswerLine,
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
  const read = useMemo(
    () =>
      linked?.status === "open" && !loaded.some((item) => item.id === linked.id)
        ? [...loaded, linked]
        : loaded,
    [linked, loaded],
  );
  // Before the first read, no item has left it.
  const missing = useMemo(
    () =>
      itemsQuery.data
        ? openRow.filter((item) => !read.some((open) => open.id === item.id))
        : [],
    [itemsQuery.data, openRow, read],
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
    return held.length > 0 ? [...read, ...held] : read;
  }, [closedElsewhere, missing, read, states]);
  // Closed items, newest closed first, as Done lists them. A Conversation
  // row says what the viewer answered until the Conversation moves on.
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const { items: closed } = useReviewItemsData({
    closed: true,
    enabled: signedIn,
    forViewer: true,
  });
  const answerOf = (conversation: Conversation): string | undefined => {
    const item = closed.find(
      (candidate) => candidate.addedByConversationId === conversation.id,
    );
    const since = conversation.lastMessageAt;
    if (
      !item?.closedAt ||
      item.closedBy?.email !== viewerEmail ||
      (since && Date.parse(item.closedAt) <= Date.parse(since))
    )
      return undefined;
    return viewerAnswerLine(item);
  };
  const attention = useAutomationAttentionData(signedIn);
  // The server counts what waits on the viewer for the tab badge. To do
  // pages on its own reads, so a count that is pending or failed cannot
  // stop it.
  const serverCounts = useInboxCountData(signedIn).data;
  const todoCount = useInboxTodoCount(signedIn) ?? 0;
  const automations = attention.data?.automations ?? [];
  const nowMs = Date.now();
  const snoozes = useInboxSnoozes(nowMs);
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

  // A notice about the subject of an ask shows on that ask's row instead,
  // and sleeps and wakes with it.
  const { folded: foldedNotices, shown } = foldNotices(
    list.filter((item) => !sweeper.isSwept(item.id)),
  );
  // A Conversation sleeps when the row snoozed for it, in To do (its asks)
  // or in Conversations (its items), still has the same newest item.
  const sleepingConversations = new Set(
    [
      ...inboxBundles(shown),
      ...inboxBundles(shown.filter((item) => item.kind === "action")),
    ]
      .filter((bundle) => snoozes.sleeps(bundle.key, bundle.newest.id))
      .map((bundle) => bundle.conversationId),
  );
  const asleep = (item: ReviewItemPayload) =>
    sleepingConversations.has(item.addedByConversationId) ||
    snoozes.sleeps(item.id, item.id);
  const awake = shown.filter((item) => !asleep(item));
  // One pin: the Conversation's own. A sweep leaves a pinned Conversation.
  const isPinned = (conversationId: string) =>
    Boolean(conversationById.get(conversationId)?.pinnedAt);

  // To do holds the asks that name the viewer. Asks for Everyone are up for
  // grabs, and notices are FYI.
  const asks = awake.filter((item) => item.kind === "action");
  const todoRows = inboxBundles(
    asks.filter((item) => !itemUpForGrabs(item)),
  ).filter((bundle) => bundle.needsYou);
  const grabRows = inboxBundles(asks.filter(itemUpForGrabs));
  const snoozedRows = inboxBundles(shown.filter(asleep));

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
  // The Inbox's own stream leaves notices to its FYI list.
  const inboxStreamRows = rowsByTime(inboxBundles(asks));

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

  // The server counts each entry, so items past the loaded pages count
  // too. Done has no count: it would need every closed item.
  const counts: Partial<Record<InboxView | "automations", number>> = {
    automations: serverCounts?.automations,
    decisions: serverCounts?.decisions,
    inbox: todoCount,
    prs: serverCounts?.codeChanges,
    snoozed: serverCounts?.snoozed,
  };

  return {
    alerts,
    /** What the viewer answered last in a Conversation, while it is news. */
    answerOf,
    automations,
    automationsError: Boolean(attention.error && !attention.data),
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
    holdOpenRow,
    includedId: linkedId,
    includeItem,
    inboxStreamRows,
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
    /** Automation alerts for To do: those the viewer has not put away. */
    todoAutomations: automations.filter(
      (automation) => !alerts.hidden(automation),
    ),
    snoozes,
    sweeper,
    titleOf,
    todoCount,
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
