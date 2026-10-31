import type { SlackAdapter } from "@chat-adapter/slack";
import { eq } from "drizzle-orm";
import { getConversationStore, getDb } from "@/chat/db";
import { runBestEffort } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import { getReviewItem, type ReviewItem } from "@/chat/review-items/store";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  deleteSlackMessage,
  postSlackMessage,
  updateSlackMessage,
} from "@/chat/slack/outbound";
import {
  buildHiddenSlackReviewItemCard,
  buildSlackReviewItemCard,
} from "@/chat/slack/review-item-card";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { juniorReviewItemSlackCards } from "@/db/schema";

type CardRow = typeof juniorReviewItemSlackCards.$inferSelect;

/**
 * Return whether a linked Slack thread can show the card. A private item
 * shows only in the thread that added it, because other linked threads can
 * have people who cannot see its source.
 */
function canShowCard(item: ReviewItem, conversationId: string): boolean {
  return (
    item.visibility === "public" ||
    conversationId === item.addedByConversationId
  );
}

function renderCard(item: ReviewItem, conversationId: string) {
  return item.conversationIds.includes(conversationId) &&
    canShowCard(item, conversationId)
    ? buildSlackReviewItemCard(item)
    : buildHiddenSlackReviewItemCard(item);
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
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  const timestamp = parseSlackMessageTs(row.messageTs);
  if (!timestamp) return;
  const card = renderCard(item, row.conversationId);
  await inWorkspace(row.teamId, getSlackAdapter, () =>
    updateSlackMessage({ ...card, channelId: row.channelId, timestamp }),
  );
}

async function postCard(
  item: ReviewItem,
  conversationId: string,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  const thread = parseSlackThreadId(conversationId);
  if (!thread) return;
  const conversation = await getConversationStore().get({ conversationId });
  const destination = conversation?.destination;
  if (destination?.platform !== "slack") return;
  await inWorkspace(destination.teamId, getSlackAdapter, async () => {
    const posted = await postSlackMessage({
      ...buildSlackReviewItemCard(item),
      channelId: thread.channelId,
      threadTs: thread.threadTs,
    });
    try {
      await getDb().insert(juniorReviewItemSlackCards).values({
        channelId: thread.channelId,
        conversationId,
        itemId: item.id,
        messageTs: posted.ts,
        teamId: destination.teamId,
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

// Long enough for the sync that holds the lock to post or change a few cards.
const SYNC_LOCK_WAIT_MS = 10_000;

/**
 * Show the current state of a Review item in its linked Slack threads. An
 * open item gets a card in each linked thread that has none. Each existing
 * card changes in place. A card in a thread that can no longer show the item
 * loses its content. A closed item posts no new cards. Syncs of one item run
 * one at a time under a state lock, so two syncs cannot post two cards in
 * one thread, and each sync reads the latest item. Cards are optional UI: a
 * failure is logged and never fails the change that caused it. Pass
 * `getSlackAdapter` outside Slack work, such as in the dashboard API, so
 * each card uses the token of its workspace.
 */
export async function syncReviewItemSlackCards(args: {
  getSlackAdapter?: () => SlackAdapter;
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
          const carded = new Set(rows.map((row) => row.conversationId));
          const missing =
            item.status === "open"
              ? item.conversationIds.filter(
                  (id) => !carded.has(id) && canShowCard(item, id),
                )
              : [];
          const results = await Promise.allSettled([
            ...rows.map((row) => updateCard(item, row, getSlackAdapter)),
            ...missing.map((id) => postCard(item, id, getSlackAdapter)),
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
