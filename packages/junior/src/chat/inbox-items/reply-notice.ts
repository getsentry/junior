import { and, eq, max, sql } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorInboxItems } from "@/db/schema";
import { inboxItemAssignedTo, REPLY_NOTICE_KEY_PREFIX } from "./access";
import {
  closeInboxItem,
  getOpenInboxItemByDedupeKey,
  insertInboxItem,
  updateInboxItemContent,
  type InboxItemContent,
} from "./store";

// A reply in a dashboard Conversation is a notice for its starter. The
// Conversation has one open reply notice at a time. Each reply replaces its
// content, and the starter's read of the latest reply closes it. A Slack
// thread already tells people, so a Conversation with a Location gets none.

function replyNoticeKey(conversationId: string): string {
  return `${REPLY_NOTICE_KEY_PREFIX}${conversationId}`;
}

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
  const access = (
    await readConversationAccessFromSql(db, [input.conversationId])
  ).get(input.conversationId);
  const tenant = access?.tenant;
  const key = replyNoticeKey(input.conversationId);
  const content: InboxItemContent = {
    assignedToEveryone: false,
    assigneeUserIds: [input.starterUserId],
    body: input.body,
    conversationIds: [input.conversationId],
    kind: "notice",
    title: input.title,
    visibility: access?.visibility === "public" ? "public" : "private",
  };
  const open = await getOpenInboxItemByDedupeKey(db, key, tenant);
  if (open) {
    const updated = await updateInboxItemContent(db, {
      ...content,
      // A private Conversation that turned public keeps its items private.
      visibility:
        open.visibility === "private" ? "private" : content.visibility,
      addedByTurnId: input.turnId,
      id: open.id,
      nowMs: input.nowMs,
    });
    if (updated) return open.id;
  }
  const inserted = await insertInboxItem(db, {
    ...content,
    addedByTurnId: input.turnId,
    dedupeKey: key,
    nowMs: input.nowMs,
    owner: { id: input.conversationId, kind: "conversation" },
    ...(tenant ? { tenant } : undefined),
  });
  // Turns of one Conversation run one at a time, so a race here is
  // unexpected. The task retry then finds the open notice and updates it.
  if (!inserted) {
    throw new Error(`Reply notice of ${input.conversationId} changed`);
  }
  return inserted.id;
}

/**
 * Close the open reply notice of a Conversation when its assignee's read
 * position reaches the latest reply. The notice holds that reply, so an
 * earlier read leaves it open.
 */
export async function closeReadReplyNotice(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    lastReadSeq: number;
    nowMs: number;
    userId: string;
  },
): Promise<void> {
  const [notice] = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.dedupeKey, replyNoticeKey(input.conversationId)),
        eq(juniorInboxItems.status, "open"),
        inboxItemAssignedTo(input.userId),
      ),
    )
    .limit(1);
  if (!notice) return;
  const [latest] = await db
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, input.conversationId),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
      ),
    );
  if (latest?.seq == null || input.lastReadSeq < latest.seq) return;
  await closeInboxItem(db, {
    closedByUserId: input.userId,
    id: notice.id,
    nowMs: input.nowMs,
    reason: "Read",
    status: "done",
  });
}
