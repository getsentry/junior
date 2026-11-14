import type { SlackAdapter } from "@chat-adapter/slack";
import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { runBestEffort } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { getReviewItem, type ReviewItem } from "@/chat/review-items/store";
import { resolveConversationRouting } from "@/chat/services/turn-session-routing";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  deleteSlackMessage,
  postSlackMessage,
  updateSlackMessage,
} from "@/chat/slack/outbound";
import { resolveSlackReplyTarget } from "@/chat/slack/reply";
import {
  buildHiddenSlackReviewItemCard,
  buildSlackReviewItemCard,
} from "@/chat/slack/review-item-card";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { findSlackThreadOwnerId } from "@/chat/slack/thread-owner";
import { juniorReviewItemSlackCards } from "@/db/schema";

type CardRow = typeof juniorReviewItemSlackCards.$inferSelect;

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
  item: ReviewItem,
  row: CardRow,
  shown: boolean,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  const timestamp = parseSlackMessageTs(row.messageTs);
  if (!timestamp) return;
  const card = shown
    ? buildSlackReviewItemCard(item)
    : buildHiddenSlackReviewItemCard(item);
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
  item: ReviewItem,
  thread: CardThread,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  await inWorkspace(thread.teamId, getSlackAdapter, async () => {
    const posted = await postSlackMessage({
      ...buildSlackReviewItemCard(item),
      channelId: thread.channelId,
      threadTs: thread.threadTs,
    });
    try {
      await getDb().insert(juniorReviewItemSlackCards).values({
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
export async function resolveSlackReviewItemCardConversationId(card: {
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
 * Return the Slack `ShowReviewItem` for app setup. Pass `getSlackAdapter`
 * outside Slack work so each card uses the token of its workspace.
 */
export function createSlackReviewItemShow(
  getSlackAdapter?: () => SlackAdapter,
): ShowReviewItem {
  return (itemId) => syncReviewItemSlackCards({ getSlackAdapter, itemId });
}

/**
 * Show the current state of a Review item in its linked Slack threads. An
 * open item gets one card in each linked thread that has none. Each existing
 * card changes in place. A card in a thread that can no longer show the item
 * loses its content. A closed item posts no new cards. Syncs of one item run
 * one at a time under a state lock, so two syncs cannot post two cards in
 * one thread, and each sync reads the latest item. Cards are optional UI: a
 * failure is logged and never fails the change that caused it. Pass
 * `getSlackAdapter` outside Slack work, such as in the dashboard API, so
 * each card uses the token of its workspace.
 */
export async function syncReviewItemSlackCards(args: {
  getSlackAdapter?: (() => SlackAdapter) | undefined;
  itemId: string;
}): Promise<void> {
  const { getSlackAdapter, itemId } = args;
  await runBestEffort(
    async () => {
      const attempt = await withLock(
        getStateAdapter(),
        `review-item-slack-cards:${itemId}`,
        async () => {
          const db = getDb();
          const item = await getReviewItem(db, itemId);
          if (!item) return;
          const rows = await db
            .select()
            .from(juniorReviewItemSlackCards)
            .where(eq(juniorReviewItemSlackCards.itemId, item.id));
          // A card is per Slack thread, not per Conversation: a child agent
          // shares the thread of its parent, so an item linked to both shows
          // one card. The row names the Conversation whose routing found the
          // thread.
          const [linked, carded] = await Promise.all([
            Promise.all(item.conversationIds.map(resolveCardThread)),
            Promise.all(
              rows.map((row) => resolveCardThread(row.conversationId)),
            ),
          ]);
          const linkedThreads = new Map<string, CardThread>();
          for (const thread of linked) {
            if (thread && !linkedThreads.has(threadKey(thread))) {
              linkedThreads.set(threadKey(thread), thread);
            }
          }
          const cardedKeys = new Set(
            carded.flatMap((thread) => (thread ? [threadKey(thread)] : [])),
          );
          const missing =
            item.status === "open"
              ? [...linkedThreads.values()].filter(
                  (thread) => !cardedKeys.has(threadKey(thread)),
                )
              : [];
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
        throw new Error("Another Review item card sync held the lock");
      }
    },
    "review_item.slack_card.sync.failed",
    { "app.review_item.id": itemId },
  );
}
