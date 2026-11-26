import { and, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
  juniorInboxItems,
} from "@/db/schema";
import { inboxItemAssignedTo } from "./access";
import {
  closeInboxItem,
  getOpenInboxItemBySubject,
  insertInboxItem,
  ownerConversationId,
  updateInboxItemContent,
  type InboxItem,
  type InboxItemContent,
} from "./store";
import { INBOX_SUBJECT_KINDS } from "./subjects";

// A reply in a dashboard Conversation is a notice for its starter. The
// Conversation has one open reply notice at a time. Each reply replaces its
// content, and the starter's read of the latest reply closes it. An open
// action that waits on the starter, or their answer to an item, also closes
// it: the item has their attention. A Slack thread already tells people, so
// a Conversation with a Location gets none.

/**
 * Add the reply notice of a Conversation for its starter, or replace the
 * content of the open one with the latest reply. Return the id of the
 * open item.
 */
export async function upsertReplyNotice(
  db: JuniorDatabase,
  input: {
    body: string;
    conversationId: string;
    nowMs: number;
    starterUserId: string;
    title: string;
    turnId: string;
  },
): Promise<string> {
  const content: InboxItemContent = {
    assignedToEveryone: false,
    assigneeUserIds: [input.starterUserId],
    body: input.body,
    conversationIds: [input.conversationId],
    kind: "notice",
    subject: { id: input.conversationId, kind: INBOX_SUBJECT_KINDS.reply },
    title: input.title,
  };
  const open = await getOpenInboxItemBySubject(db, content.subject);
  if (open) {
    const updated = await updateInboxItemContent(db, {
      ...content,
      addedByTurnId: input.turnId,
      id: open.id,
      nowMs: input.nowMs,
    });
    if (updated) return open.id;
  }
  const inserted = await insertInboxItem(db, {
    ...content,
    addedByTurnId: input.turnId,
    nowMs: input.nowMs,
    owner: { id: input.conversationId, kind: "conversation" },
  });
  // Turns of one Conversation run one at a time, so a race here is
  // unexpected. The task retry then finds the open notice and updates it.
  if (!inserted) {
    throw new Error(`Reply notice of ${input.conversationId} changed`);
  }
  return inserted.id;
}

/**
 * Return whether the User read the latest reply of a Conversation: their
 * read position reaches it, or they wrote a later Message. Conversation
 * status reads a starter's read the same way.
 */
export async function hasReadLatestReply(
  db: JuniorDatabase,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const [latest] = await db
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
      ),
    );
  const replySeq = latest?.seq;
  if (replySeq == null) return false;
  const [position] = await db
    .select({ lastReadSeq: juniorConversationReadPositions.lastReadSeq })
    .from(juniorConversationReadPositions)
    .where(
      and(
        eq(juniorConversationReadPositions.conversationId, conversationId),
        eq(juniorConversationReadPositions.userId, userId),
      ),
    )
    .limit(1);
  if (position && position.lastReadSeq >= replySeq) return true;
  const [later] = await db
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationEvents.actorIdentityId),
    )
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        gt(juniorConversationEvents.seq, replySeq),
        eq(juniorIdentities.userId, userId),
      ),
    )
    .limit(1);
  return later !== undefined;
}

/**
 * Close the User's open reply notice of a Conversation when they read the
 * latest reply. The notice holds that reply, so an earlier read leaves it
 * open.
 */
export async function closeReadReplyNotice(
  db: JuniorDatabase,
  input: { conversationId: string; nowMs: number; userId: string },
): Promise<void> {
  const notice = await openReplyNoticeId(db, input);
  if (!notice) return;
  if (!(await hasReadLatestReply(db, input.conversationId, input.userId))) {
    return;
  }
  await closeRead(db, notice, input);
}

/**
 * Close the User's open reply notice of a Conversation, because an open
 * action in it already waits on them.
 */
export async function closeWaitingReplyNotice(
  db: JuniorDatabase,
  input: { conversationId: string; nowMs: number; userId: string },
): Promise<void> {
  const notice = await openReplyNoticeId(db, input);
  if (!notice) return;
  await closeInboxItem(db, {
    id: notice,
    nowMs: input.nowMs,
    reason: "Item waits on you",
    status: "done",
  });
}

/**
 * Close the User's open reply notices of the Conversations of an Inbox item
 * that they answered or dismissed. An item of a child Conversation closes
 * the notice of its root too. A dismissed reply notice is already closed,
 * so it finds no open notice.
 */
export async function closeHandledReplyNotices(
  db: JuniorDatabase,
  input: {
    item: Pick<InboxItem, "conversationIds" | "owner">;
    nowMs: number;
    userId: string;
  },
): Promise<void> {
  const owner = ownerConversationId(input.item);
  const ids = [
    ...new Set([...input.item.conversationIds, ...(owner ? [owner] : [])]),
  ];
  if (ids.length === 0) return;
  const roots = await db
    .select({ id: juniorConversations.rootConversationId })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, ids));
  const conversationIds = new Set([
    ...ids,
    ...roots.flatMap((root) => root.id ?? []),
  ]);
  /* oxlint-disable no-await-in-loop -- Usually one or two Conversations. */
  for (const conversationId of conversationIds) {
    const notice = await openReplyNoticeId(db, {
      conversationId,
      userId: input.userId,
    });
    if (!notice) continue;
    await closeInboxItem(db, {
      closedByUserId: input.userId,
      id: notice,
      nowMs: input.nowMs,
      reason: "Item handled",
      status: "done",
    });
  }
  /* oxlint-enable no-await-in-loop */
}

async function openReplyNoticeId(
  db: JuniorDatabase,
  input: { conversationId: string; userId: string },
): Promise<string | undefined> {
  const [notice] = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.reply),
        eq(juniorInboxItems.subjectId, input.conversationId),
        eq(juniorInboxItems.status, "open"),
        inboxItemAssignedTo(input.userId),
      ),
    )
    .limit(1);
  return notice?.id;
}

async function closeRead(
  db: JuniorDatabase,
  id: string,
  input: { nowMs: number; userId: string },
): Promise<void> {
  await closeInboxItem(db, {
    closedByUserId: input.userId,
    id,
    nowMs: input.nowMs,
    reason: "Read",
    status: "done",
  });
}
