import type { SlackAdapter } from "@chat-adapter/slack";
import { and, eq } from "drizzle-orm";
import { getConversationStore, getDb } from "@/chat/db";
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
import { juniorReviewItemSlackCards } from "@/db/schema";

type CardRow = typeof juniorReviewItemSlackCards.$inferSelect;

/** The Slack thread where one linked Conversation shows its card. */
interface CardThread {
  channelId: string;
  conversationId: string;
  teamId: string;
  threadTs: string;
}

function renderCard(item: ReviewItem, conversationId: string) {
  return item.conversationIds.includes(conversationId)
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

async function resolveCardThread(
  conversationId: string,
): Promise<CardThread | undefined> {
  // An Automation run can own a Slack thread with an id that is not a Slack
  // thread id, so the thread comes from the Conversation routing.
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

/** Return the Conversation that gets Slack input in one thread. */
async function threadOwnerId(thread: CardThread): Promise<string> {
  return (
    (await getConversationStore().getConversationIdByProviderConversation({
      provider: "slack",
      providerConversationId: thread.threadTs,
      providerDestinationId: thread.channelId,
      providerTenantId: thread.teamId,
    })) ?? `slack:${thread.channelId}:${thread.threadTs}`
  );
}

/**
 * Plan one card for each linked Slack thread. A child agent shares the
 * thread of its parent, so an item linked to both must not post two cards
 * in one thread. The Conversation that owns the thread gets the card,
 * because a click on the card is Slack input to that Conversation. So a card
 * that a linked child holds moves to the owner once the owner is linked.
 */
async function planCards(
  conversationIds: readonly string[],
  rows: readonly CardRow[],
): Promise<{
  moves: Array<{ conversationId: string; row: CardRow }>;
  posts: CardThread[];
}> {
  const rowOf = new Map(rows.map((row) => [row.conversationId, row]));
  const threads = await Promise.all(conversationIds.map(resolveCardThread));
  const byThread = new Map<string, CardThread[]>();
  for (const thread of threads) {
    if (!thread) continue;
    const key = `${thread.teamId}:${thread.channelId}:${thread.threadTs}`;
    byThread.set(key, [...(byThread.get(key) ?? []), thread]);
  }
  const moves: Array<{ conversationId: string; row: CardRow }> = [];
  const posts: CardThread[] = [];
  await Promise.all(
    [...byThread.values()].map(async (group) => {
      const ownerId = await threadOwnerId(group[0]!);
      const owner = group.find((t) => t.conversationId === ownerId);
      const row = group
        .map((t) => rowOf.get(t.conversationId))
        .find((found) => found !== undefined);
      if (!row) {
        posts.push(owner ?? group[0]!);
      } else if (owner && !rowOf.has(owner.conversationId)) {
        moves.push({ conversationId: owner.conversationId, row });
      }
    }),
  );
  return { moves, posts };
}

/** Give an existing card to the Conversation that owns its thread. */
async function moveCard(move: {
  conversationId: string;
  row: CardRow;
}): Promise<CardRow> {
  await getDb()
    .update(juniorReviewItemSlackCards)
    .set({ conversationId: move.conversationId })
    .where(
      and(
        eq(juniorReviewItemSlackCards.itemId, move.row.itemId),
        eq(juniorReviewItemSlackCards.conversationId, move.row.conversationId),
      ),
    );
  return { ...move.row, conversationId: move.conversationId };
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
 * Return the Conversation that a card belongs to. A card posts into the
 * thread of its Conversation routing, and an Automation run can own a
 * thread with an id that is not a Slack thread id. So the card row, not the
 * thread, names the Conversation.
 */
export async function readSlackReviewItemCardConversationId(card: {
  channelId: string;
  itemId: string;
  messageTs: string;
}): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ conversationId: juniorReviewItemSlackCards.conversationId })
    .from(juniorReviewItemSlackCards)
    .where(
      and(
        eq(juniorReviewItemSlackCards.itemId, card.itemId),
        eq(juniorReviewItemSlackCards.channelId, card.channelId),
        eq(juniorReviewItemSlackCards.messageTs, card.messageTs),
      ),
    )
    .limit(1);
  return row?.conversationId;
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
          const plan =
            item.status === "open"
              ? await planCards(item.conversationIds, rows)
              : { moves: [], posts: [] };
          const moved = new Set(plan.moves.map((move) => move.row));
          const current = [
            ...rows.filter((row) => !moved.has(row)),
            ...(await Promise.all(plan.moves.map(moveCard))),
          ];
          const results = await Promise.allSettled([
            ...current.map((row) => updateCard(item, row, getSlackAdapter)),
            ...plan.posts.map((thread) =>
              postCard(item, thread, getSlackAdapter),
            ),
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
