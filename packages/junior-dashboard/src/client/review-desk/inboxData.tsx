import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { pinnedFirst } from "../conversations/conversationSections";
import type { Conversation } from "../types";
import { itemsInView, type InboxView } from "./inboxModel";
import { useInboxSnoozes } from "./inboxSnooze";
import {
  useAutomationAttentionData,
  useLinkedConversationTitles,
  useReviewItemCountData,
  useReviewItemData,
  useReviewItemsData,
  scrollPages,
} from "./queries";
import { inboxBundles, type InboxBundle } from "./reviewItemFormat";
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
  // A link can name an open item past the loaded page. It joins the list.
  const [linkedId, includeItem] = useState<string>();
  const linked = useReviewItemData(linkedId).data;
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
  const count = useReviewItemCountData(signedIn);
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
  const snoozedRows = inboxBundles(live.filter(asleep));

  // Every Conversation, pinned first in the viewer's order, then newest
  // activity. A Conversation outside the loaded feed joins when it has
  // open items.
  const conversationRows: ConversationRow[] = [
    ...pinnedFirst(conversations).map(
      (conversation): ConversationRow => ({
        bundle: bundleByConversation.get(conversation.id),
        conversation,
        conversationId: conversation.id,
        time: activityAt(conversation),
      }),
    ),
    ...bundles
      .filter((bundle) => !conversationById.has(bundle.conversationId))
      .map(
        (bundle): ConversationRow => ({
          bundle,
          conversationId: bundle.conversationId,
          time: bundle.newest.createdAt,
        }),
      ),
  ];

  // In flight: running Conversations, then the pins in the viewer's order,
  // each one click away.
  const pinned = conversations.filter((conversation) => conversation.pinnedAt);
  const inFlight = [
    ...conversations.filter(
      (conversation) =>
        conversation.status === "active" && !conversation.pinnedAt,
    ),
    ...pinnedFirst(pinned),
  ];

  const todoCount = count.data
    ? count.data.needsViewer + count.data.automations
    : 0;
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
    inFlight: inFlight.slice(0, IN_FLIGHT_LIMIT),
    inFlightCount: inFlight.length,
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
