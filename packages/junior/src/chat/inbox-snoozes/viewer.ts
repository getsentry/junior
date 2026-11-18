import type { User } from "@sentry/junior-plugin-api";
import { and, countDistinct, eq } from "drizzle-orm";
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
  snoozeInboxRow,
  unsnoozeInboxRow,
  type InboxSnooze,
  type InboxSnoozeSubject,
} from "./store";

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

/**
 * Return the root Conversation of the row when the viewer can see an open
 * Review item in it. A missing row and a hidden row look the same.
 */
async function visibleRowRoot(
  user: User,
  subject: InboxSnoozeSubject,
): Promise<string> {
  const root = await rootConversationId(subject.conversationId);
  if (!root) throw new InboxRowNotFoundError("Inbox row was not found.");
  if (subject.reviewItemId) {
    const item = await getReviewItem(getDb(), subject.reviewItemId);
    const roots = item
      ? await Promise.all(item.conversationIds.map(rootConversationId))
      : [];
    if (
      item?.status === "open" &&
      roots.includes(root) &&
      (await canUserReadReviewItem(item, user))
    ) {
      return root;
    }
    throw new InboxRowNotFoundError("Inbox row was not found.");
  }
  const reader = await reviewItemReaderForUserInConversation(user, root);
  const [visible] = await getDb()
    .select({ id: juniorReviewItems.id })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reader),
        reviewItemInRow(root),
      ),
    )
    .limit(1);
  if (!visible) throw new InboxRowNotFoundError("Inbox row was not found.");
  return root;
}

/**
 * Snooze one Inbox row for the viewer until `wakeAtMs`, or until a new item
 * in its Conversation. It replaces the viewer's earlier snooze on the row.
 */
export async function createViewerSnooze(
  user: User,
  input: { subject: InboxSnoozeSubject; wakeAtMs: number },
  nowMs = Date.now(),
): Promise<InboxSnooze> {
  if (input.wakeAtMs <= nowMs) {
    throw new InboxSnoozeInputError("The wake time must be in the future.");
  }
  const root = await visibleRowRoot(user, input.subject);
  return snoozeInboxRow(getDb(), {
    nowMs,
    subject: {
      conversationId: root,
      ...(input.subject.reviewItemId
        ? { reviewItemId: input.subject.reviewItemId }
        : undefined),
    },
    userId: user.id,
    wakeAtMs: input.wakeAtMs,
  });
}

/**
 * Undo the viewer's snoozes on one Inbox row, so it comes back now. A row
 * with no snooze of theirs does not change.
 */
export async function unsnoozeViewerRow(
  user: User,
  subject: InboxSnoozeSubject,
): Promise<void> {
  const root = await rootConversationId(subject.conversationId);
  if (!root) return;
  await unsnoozeInboxRow(getDb(), {
    subject: {
      conversationId: root,
      ...(subject.reviewItemId
        ? { reviewItemId: subject.reviewItemId }
        : undefined),
    },
    userId: user.id,
  });
}

/**
 * Count the Inbox rows that the viewer snoozed, as Snoozed lists them: one
 * per Conversation that added an open item that a snooze hides. One snooze
 * on a root Conversation can hide the rows of several.
 */
export async function countViewerSnoozes(
  user: User,
  nowMs = Date.now(),
): Promise<number> {
  const [row] = await getDb()
    .select({ count: countDistinct(juniorReviewItems.addedByConversationId) })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.status, "open"),
        reviewItemVisibleTo(reviewItemReaderForUser(user)),
        reviewItemForUser(user.id),
        reviewItemSnoozedBy(user.id, nowMs),
      ),
    );
  return row?.count ?? 0;
}
