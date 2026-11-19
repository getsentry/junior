import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, count, eq, inArray } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  canUserReadReviewItem,
  reviewItemForUser,
  reviewItemReaderForUser,
  reviewItemReaderForUserInConversation,
  reviewItemVisibleTo,
} from "@/chat/review-items/access";
import { getReviewItem } from "@/chat/review-items/store";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorReviewItems } from "@/db/schema/review-items";
import {
  reviewItemInRow,
  reviewItemSnoozedBy,
  settleInboxSnoozes,
  snoozeInboxItems,
  unsnoozeInboxRow,
} from "./store";
import { scheduleInboxSnoozeTimer } from "./triggers";

/** The Inbox row of a snooze: a root Conversation, or one item in it. */
export interface InboxSnoozeSubject {
  conversationId: string;
  reviewItemId?: string;
}

/** A snooze request that the viewer may not make, such as a past time. */
export class InboxSnoozeInputError extends Error {}

/** The viewer cannot see the Inbox row, or it does not exist. */
export class InboxRowNotFoundError extends Error {}

async function rootConversationId(
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row ? (row.rootConversationId ?? row.conversationId) : undefined;
}

/** The root Conversations of these Conversations, in one read. */
async function rootConversationIds(
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, conversationIds));
  return rows.map((row) => row.rootConversationId ?? row.conversationId);
}

/**
 * Return the open Review items of the row that the viewer can see: the one
 * item, or every item in the root Conversation's row. A missing row and a
 * hidden row look the same.
 */
async function visibleRowItems(
  user: User,
  root: string,
  reviewItemId: string | undefined,
): Promise<string[]> {
  if (reviewItemId) {
    const item = await getReviewItem(getDb(), reviewItemId);
    const roots = item ? await rootConversationIds(item.conversationIds) : [];
    if (
      item?.status === "open" &&
      roots.includes(root) &&
      (await canUserReadReviewItem(item, user))
    ) {
      return [item.id];
    }
    return [];
  }
  const reader = await reviewItemReaderForUserInConversation(user, root);
  const rows = await getDb()
    .select({ id: juniorReviewItems.id })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reader),
        reviewItemInRow(root),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Snooze the open items of one Inbox row for the viewer until `wakeAtMs`.
 * Each item gets its own snooze, which replaces the viewer's earlier one;
 * a later item in the row shows by itself. Returns the snoozed items.
 */
export async function createViewerSnooze(
  user: User,
  input: { subject: InboxSnoozeSubject; wakeAtMs: number },
  nowMs = Date.now(),
): Promise<string[]> {
  if (input.wakeAtMs <= nowMs) {
    throw new InboxSnoozeInputError("The wake time must be in the future.");
  }
  const root = await rootConversationId(input.subject.conversationId);
  const reviewItemIds = root
    ? await visibleRowItems(user, root, input.subject.reviewItemId)
    : [];
  if (!root || reviewItemIds.length === 0) {
    throw new InboxRowNotFoundError("Inbox row was not found.");
  }
  const timerId = `inbox-snooze:${randomUUID()}`;
  const snoozeIds = await snoozeInboxItems(getDb(), {
    nowMs,
    reviewItemIds,
    timerId,
    userId: user.id,
  });
  // Add the timer only after the snoozes commit: a heartbeat that claims a
  // timer with no snooze yet removes it. If the add fails, cancel the
  // snoozes, so no item stays hidden with no timer to wake it.
  try {
    await scheduleInboxSnoozeTimer(timerId, input.wakeAtMs);
  } catch (error) {
    await settleInboxSnoozes(getDb(), { snoozeIds, state: "cancelled" });
    throw error;
  }
  return reviewItemIds;
}

/**
 * Wake the viewer's snoozes on one Inbox row now. A row with no snooze of
 * theirs does not change.
 */
export async function unsnoozeViewerRow(
  user: User,
  subject: InboxSnoozeSubject,
): Promise<void> {
  const root = await rootConversationId(subject.conversationId);
  if (!root) return;
  await unsnoozeInboxRow(getDb(), {
    rootConversationId: root,
    ...(subject.reviewItemId
      ? { reviewItemId: subject.reviewItemId }
      : undefined),
    userId: user.id,
  });
}

/**
 * Count the open items that the viewer snoozed. Snoozed shows a card for
 * each, as a root Conversation's stack does.
 */
export async function countViewerSnoozes(user: User): Promise<number> {
  const [row] = await getDb()
    .select({ count: count() })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reviewItemReaderForUser(user)),
        reviewItemForUser(user.id),
        reviewItemSnoozedBy(user.id),
      ),
    );
  return row?.count ?? 0;
}
