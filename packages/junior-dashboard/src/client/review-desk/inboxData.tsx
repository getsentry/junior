import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { pinnedFirst } from "../conversations/conversationSections";
import type { Conversation } from "../types";
import { itemsInView, type InboxView } from "./inboxModel";
import { useLinkedInboxItems } from "./inboxListState";
import { useInboxSnoozes } from "./inboxSnooze";
import {
  useAutomationAttentionData,
  useLinkedConversationTitles,
  useInboxTodoCount,
  useReviewItemData,
  useReviewItemsData,
  scrollPages,
} from "./queries";
import {
  inboxBundles,
  itemNeedsViewer,
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
  const { items: loaded, query: itemsQuery } = useReviewItemsData({
    enabled: signedIn,
    forViewer: true,
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
  const list = useMemo(
    () =>
      linked?.status === "open" && !loaded.some((item) => item.id === linked.id)
        ? [...loaded, linked]
        : loaded,
    [linked, loaded],
  );
  const attention = useAutomationAttentionData(signedIn);
  // The server counts what waits on the viewer, so the tab badge and To do
  // read the same number.
  const todoCount = useInboxTodoCount(signedIn) ?? 0;
  const automations = attention.data?.automations ?? [];
  const nowMs = Date.now();
  const snoozes = useInboxSnoozes(nowMs);
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

  const live = list.filter((item) => !sweeper.isSwept(item.id));
  const sleepingConversations = new Set(
    inboxBundles(live)
      .filter((bundle) => snoozes.sleeps(bundle.key, bundle.newest.id))
      .map((bundle) => bundle.conversationId),
  );
  const asleep = (item: ReviewItemPayload) =>
    sleepingConversations.has(item.addedByConversationId) ||
    snoozes.sleeps(item.id, item.id);
  const awake = live.filter((item) => !asleep(item));
  // One pin: the Conversation's own. A sweep leaves a pinned Conversation.
  const isPinned = (conversationId: string) =>
    Boolean(conversationById.get(conversationId)?.pinnedAt);

  const bundles = inboxBundles(awake);
  const bundleByConversation = new Map(
    bundles.map((bundle) => [bundle.conversationId, bundle]),
  );
  const todoRows = bundles.filter((bundle) => bundle.needsYou);
  // What To do has loaded of what the count counts: the asks that wait on
  // the viewer, and the Automations that need their attention.
  const todoLoaded =
    todoRows.flatMap((row) => row.items).filter(itemNeedsViewer).length +
    automations.length;
  const snoozedRows = inboxBundles(live.filter(asleep));

  // Every Conversation, pinned first in the viewer's order, then newest
  // activity. A Conversation outside the loaded feed joins when it has
  // open items.
  const conversationRows = withRowsByTime(
    pinnedFirst(conversations).map(
      (conversation): ConversationRow => ({
        bundle: bundleByConversation.get(conversation.id),
        conversation,
        conversationId: conversation.id,
        time: activityAt(conversation),
      }),
    ),
    bundles
      .filter((bundle) => !conversationById.has(bundle.conversationId))
      .map(
        (bundle): ConversationRow => ({
          bundle,
          conversationId: bundle.conversationId,
          time: bundle.newest.createdAt,
        }),
      ),
  );

  // In flight: every pin, each one click away, and running Conversations in
  // the rows left, up to IN_FLIGHT_LIMIT. Running rows come first, a running
  // pin with them, then the other pins in the viewer's order.
  const pinned = pinnedFirst(
    conversations.filter((conversation) => conversation.pinnedAt),
  );
  const running = conversations.filter(
    (conversation) =>
      conversation.status === "active" && !conversation.pinnedAt,
  );
  const inFlight = [
    ...running.slice(0, Math.max(0, IN_FLIGHT_LIMIT - pinned.length)),
    ...pinned.filter((conversation) => conversation.status === "active"),
    ...pinned.filter((conversation) => conversation.status !== "active"),
  ];

  // Done has no count: it would need every closed item.
  const counts: Partial<Record<InboxView, number>> = {
    automations: automations.length,
    decisions: itemsInView(awake, "decisions").length,
    inbox: todoCount,
    prs: itemsInView(awake, "prs").length,
    snoozed: snoozedRows.length,
  };

  return {
    automations,
    automationsError: Boolean(attention.error && !attention.data),
    awake,
    conversationById,
    conversationRows,
    counts,
    feed,
    includedId: linkedId,
    includeItem,
    inFlight,
    inFlightCount: running.length + pinned.length,
    isPinned,
    // The open asks load a page at a time too, as the list scrolls.
    itemPages: scrollPages(itemsQuery),
    itemsError: Boolean(itemsQuery.error && !itemsQuery.data),
    // Signed out, there are no asks to wait for.
    itemsLoaded: !signedIn || Boolean(itemsQuery.data),
    nowMs,
    pinnedCount: pinned.length,
    signedIn,
    snoozedRows,
    snoozes,
    sweeper,
    titleOf,
    todoCount,
    todoLoaded,
    todoRows,
  };
}

/**
 * Load and shape what the Inbox sidebar and its lists show: the open asks,
 * the Automations that need attention, snoozes, sweeps, and the
 * Conversations they belong to. Both read this one value, so a count always
 * matches its list and a sweep shows in both at once.
 */
export function InboxDataProvider(props: {
  children: ReactNode;
  conversations: Conversation[];
  feed: InboxFeedPages;
  signedIn: boolean;
}) {
  const value = useBuildInboxData(props);
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
