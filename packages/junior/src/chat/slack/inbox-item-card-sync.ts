import { mapBounded } from "@/chat/fan-out";
import type { SlackAdapter } from "@chat-adapter/slack";
import { eq } from "drizzle-orm";
import { isConversationDeliveryPaused } from "@/chat/conversations/delivery-pause";
import { getDb } from "@/chat/db";
import { runBestEffort } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { getInboxItem, type InboxItem } from "@/chat/inbox-items/store";
import { resolveConversationRouting } from "@/chat/services/turn-session-routing";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  deleteSlackMessage,
  // ast-grep-ignore: no-raw-slack-turn-post -- inbox item card that changes in place, not reply text
  postSlackMessage,
  updateSlackMessage,
} from "@/chat/slack/outbound";
import { resolveSlackReplyTarget } from "@/chat/slack/reply";
import {
  buildHiddenSlackInboxItemCard,
  buildSlackInboxItemCard,
} from "@/chat/slack/inbox-item-card";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { findSlackThreadOwnerId } from "@/chat/slack/thread-owner";
import { juniorInboxItemSlackCards } from "@/db/schema";

type CardRow = typeof juniorInboxItemSlackCards.$inferSelect;

/** The Slack thread where one Conversation shows its cards. */
interface CardThread {
  channelId: string;
  conversationId: string;
  teamId: string;
  threadTs: string;
}

function threadKey(thread: CardThread): string {
  return `${thread.teamId}:${thread.channelId}:${thread.threadTs}`;
}

async function inWorkspace(
  teamId: string,
  getSlackAdapter: (() => SlackAdapter) | undefined,
  task: () => Promise<void>,
): Promise<void> {
  if (!getSlackAdapter) return await task();
  await runWithSlackInstallation({
    adapter: getSlackAdapter(),
    installation: { teamId },
    task,
  });
}

async function updateCard(
  item: InboxItem,
  row: CardRow,
  shown: boolean,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  const timestamp = parseSlackMessageTs(row.messageTs);
  if (!timestamp) return;
  const card = shown
    ? buildSlackInboxItemCard(item)
    : buildHiddenSlackInboxItemCard(item);
  await inWorkspace(row.teamId, getSlackAdapter, () =>
    updateSlackMessage({ ...card, channelId: row.channelId, timestamp }),
  );
}

async function resolveCardThread(
  conversationId: string,
): Promise<CardThread | undefined> {
  // An Automation run can own a Slack thread with an id that is not a Slack
  // thread id, and a child agent shares the thread of its parent. So the
  // thread comes from the Conversation routing.
  const routing = await resolveConversationRouting({ conversationId });
  const destination = routing?.destination;
  if (destination?.platform !== "slack") return undefined;
  const thread = resolveSlackReplyTarget({
    destination,
    ...(routing?.location ? { location: routing.location } : undefined),
  });
  // A card belongs in the thread of its Conversation, never at channel top.
  if (!thread.threadTs) return undefined;
  return {
    channelId: thread.channelId,
    conversationId,
    teamId: destination.teamId,
    threadTs: thread.threadTs,
  };
}

async function postCard(
  item: InboxItem,
  thread: CardThread,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  await inWorkspace(thread.teamId, getSlackAdapter, async () => {
    // ast-grep-ignore: no-raw-slack-turn-post -- inbox item card that changes in place, not reply text
    const posted = await postSlackMessage({
      ...buildSlackInboxItemCard(item),
      channelId: thread.channelId,
      threadTs: thread.threadTs,
    });
    try {
      await getDb().insert(juniorInboxItemSlackCards).values({
        channelId: thread.channelId,
        conversationId: thread.conversationId,
        itemId: item.id,
        messageTs: posted.ts,
        teamId: thread.teamId,
      });
    } catch (error) {
      // A card without a row never changes, so remove it.
      await deleteSlackMessage({
        channelId: thread.channelId,
        timestamp: posted.ts,
      });
      throw error;
    }
  });
}

/**
 * Return the Conversation that a card click acts for: the Conversation that
 * gets Slack input in the card thread, the same as for a typed reply.
 */
export async function resolveSlackInboxItemCardConversationId(card: {
  channelId: string;
  teamId: string;
  threadTs: string;
}): Promise<string> {
  return (
    (await findSlackThreadOwnerId(card)) ??
    `slack:${card.channelId}:${card.threadTs}`
  );
}

// Long enough for the sync that holds the lock to post or change a few cards.
const SYNC_LOCK_WAIT_MS = 10_000;

/**
 * Return the Slack `ShowInboxItem` for app setup. Pass `getSlackAdapter`
 * outside Slack work so each card uses the token of its workspace.
 */
export function createSlackInboxItemShow(
  getSlackAdapter?: () => SlackAdapter,
): ShowInboxItem {
  return (itemId) => syncInboxItemSlackCards({ getSlackAdapter, itemId });
}

/**
 * Show the current state of an Inbox item in its linked Slack threads. An
 * open item gets one card in each linked thread that has none and is not
 * detached. Each existing
 * card changes in place. A card in a thread that can no longer show the item
 * loses its content. A closed item posts no new cards. Syncs of one item run
 * one at a time under a state lock, so two syncs cannot post two cards in
 * one thread, and each sync reads the latest item. Cards are optional UI: a
 * failure is logged and never fails the change that caused it. Pass
 * `getSlackAdapter` outside Slack work, such as in the dashboard API, so
 * each card uses the token of its workspace.
 */
export async function syncInboxItemSlackCards(args: {
  getSlackAdapter?: (() => SlackAdapter) | undefined;
  itemId: string;
}): Promise<void> {
  const { getSlackAdapter, itemId } = args;
  await runBestEffort(
    async () => {
      const attempt = await withLock(
        getStateAdapter(),
        `inbox-item-slack-cards:${itemId}`,
        async () => {
          const db = getDb();
          const item = await getInboxItem(db, itemId);
          if (!item) return;
          const rows = await db
            .select()
            .from(juniorInboxItemSlackCards)
            .where(eq(juniorInboxItemSlackCards.itemId, item.id));
          // A card is per Slack thread, not per Conversation: a child agent
          // shares the thread of its parent, so an item linked to both shows
          // one card. The row names the Conversation whose routing found the
          // thread.
          const conversationIds = [
            ...new Set([
              ...item.conversationIds,
              ...rows.map((row) => row.conversationId),
            ]),
          ];
          const resolved = await mapBounded(conversationIds, resolveCardThread);
          const threadOf = (conversationId: string) =>
            resolved[conversationIds.indexOf(conversationId)];
          const linked = item.conversationIds.map(threadOf);
          const carded = rows.map((row) => threadOf(row.conversationId));
          const linkedThreads = new Map<string, CardThread>();
          for (const thread of linked) {
            if (thread && !linkedThreads.has(threadKey(thread))) {
              linkedThreads.set(threadKey(thread), thread);
            }
          }
          const cardedKeys = new Set(
            carded.flatMap((thread) => (thread ? [threadKey(thread)] : [])),
          );
          const uncarded =
            item.status === "open"
              ? [...linkedThreads.values()].filter(
                  (thread) => !cardedKeys.has(threadKey(thread)),
                )
              : [];
          // A detached thread gets no new card. A card that it already has
          // still changes in place, so it does not show a stale state.
          const missing = (
            await mapBounded(uncarded, async (thread) =>
              (await isConversationDeliveryPaused(thread.conversationId))
                ? []
                : [thread],
            )
          ).flat();
          const results = await Promise.allSettled([
            ...rows.map((row, index) => {
              const thread = carded[index];
              const shown = !!thread && linkedThreads.has(threadKey(thread));
              return updateCard(item, row, shown, getSlackAdapter);
            }),
            ...missing.map((thread) => postCard(item, thread, getSlackAdapter)),
          ]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
        },
        { waitMs: SYNC_LOCK_WAIT_MS },
      );
      if (!attempt.acquired) {
        throw new Error("Another Inbox item card sync held the lock");
      }
    },
    "inbox_item.slack_card.sync.failed",
    { "app.inbox_item.id": itemId },
  );
}
