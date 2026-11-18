import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema/conversations";
import {
  juniorInboxSnoozes,
  juniorInboxSnoozeTriggers,
} from "@/db/schema/inbox-snoozes";
import {
  juniorReviewItemConversations,
  juniorReviewItems,
} from "@/db/schema/review-items";

/** The Inbox row that a snooze hides: one Conversation, or one item in it. */
export interface InboxSnoozeSubject {
  /** The root Conversation of the row. */
  conversationId: string;
  reviewItemId?: string;
}

/** A stored snooze. */
export type InboxSnooze = typeof juniorInboxSnoozes.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A snooze that is no longer active is deleted this long after it was made. */
const SNOOZE_RETENTION_MS = 30 * DAY_MS;
// Bound one heartbeat or retention pass. The rest waits for the next one;
// reads already treat a due snooze as woken.
const SNOOZE_BATCH_LIMIT = 1000;

/** Why a snooze left `active`. */
const SNOOZE_REASON = {
  newItem: "new_item",
  replaced: "replaced",
  time: "time",
  unsnoozed: "unsnoozed",
} as const;

/**
 * The trigger Event of a new Review item in the row's Conversation. Its
 * identifier is the row's root Conversation. Every snooze has it.
 */
const NEW_ITEM_EVENT_TYPE = "review_item.created";

const linkRoot = alias(juniorConversations, "snooze_link_root");
const itemLink = alias(juniorReviewItemConversations, "snooze_item_link");

const queries = new QueryBuilder();

/** Subquery: the root Conversation of each Conversation that the item links. */
function rowRootsOfItem(itemId: SQL | string) {
  return queries
    .select({
      root: sql<string>`coalesce(${linkRoot.rootConversationId}, ${itemLink.conversationId})`,
    })
    .from(itemLink)
    .leftJoin(linkRoot, eq(linkRoot.conversationId, itemLink.conversationId))
    .where(eq(itemLink.itemId, itemId));
}

/** SQL: the snooze has not woken, so its row stays hidden. */
function asleepAt(nowMs: number): SQL {
  // A wake time at or before now has passed, even before the heartbeat
  // settles it.
  return and(
    eq(juniorInboxSnoozes.status, "active"),
    gt(juniorInboxSnoozes.wakeAtMs, nowMs),
  )!;
}

/**
 * SQL: this User snoozed the Inbox row of the Review item, and the snooze has
 * not woken. The row is the item itself, or the root Conversation of a
 * Conversation that the item links.
 */
export function reviewItemSnoozedBy(userId: string, nowMs: number): SQL {
  return sql`exists (select 1 from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${asleepAt(nowMs)} and (${juniorInboxSnoozes.reviewItemId} = ${juniorReviewItems.id} or (${juniorInboxSnoozes.reviewItemId} is null and ${juniorInboxSnoozes.conversationId} in ${rowRootsOfItem(sql`${juniorReviewItems.id}`)})))`;
}

/**
 * SQL for the Inbox versions token: it changes when this User snoozes a row,
 * or when one of their snoozes wakes or is undone. A due snooze counts as
 * woken, as Inbox reads treat it, before the heartbeat settles it.
 */
export function inboxSnoozesVersion(
  userId: string,
  nowMs: number,
): SQL<string> {
  return sql<string>`(select concat_ws(':', count(*) filter (where ${juniorInboxSnoozes.wakeAtMs} > ${nowMs}), max(${juniorInboxSnoozes.createdAt})) from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${juniorInboxSnoozes.status} = 'active')`;
}

/** SQL: this User's active snoozes on this Inbox row. */
function activeSnoozesOnRow(userId: string, subject: InboxSnoozeSubject): SQL {
  return and(
    eq(juniorInboxSnoozes.userId, userId),
    eq(juniorInboxSnoozes.status, "active"),
    eq(juniorInboxSnoozes.conversationId, subject.conversationId),
    subject.reviewItemId
      ? eq(juniorInboxSnoozes.reviewItemId, subject.reviewItemId)
      : isNull(juniorInboxSnoozes.reviewItemId),
  )!;
}

/**
 * Snooze one Inbox row for one User until `wakeAtMs`, or until a new Review
 * item in the row's Conversation. The User's earlier snooze on the row is
 * cancelled as replaced. `subject.conversationId` must be a root
 * Conversation, and the caller must check that the User can see the row.
 */
export async function snoozeInboxRow(
  db: JuniorDatabase,
  input: {
    userId: string;
    nowMs: number;
    subject: InboxSnoozeSubject;
    wakeAtMs: number;
  },
): Promise<InboxSnooze> {
  // Serialize snoozes of one User on one row, so overlapping requests
  // replace in turn instead of failing on the unique index.
  const lockKey = [
    "junior:inbox-snooze",
    input.userId,
    input.subject.conversationId,
    input.subject.reviewItemId ?? "",
  ].join(":");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx
      .update(juniorInboxSnoozes)
      .set({ status: "cancelled", reason: SNOOZE_REASON.replaced })
      .where(activeSnoozesOnRow(input.userId, input.subject));
    const [snooze] = await tx
      .insert(juniorInboxSnoozes)
      .values({
        conversationId: input.subject.conversationId,
        createdAt: new Date(input.nowMs),
        id: randomUUID(),
        reviewItemId: input.subject.reviewItemId ?? null,
        status: "active",
        userId: input.userId,
        wakeAtMs: input.wakeAtMs,
      })
      .returning();
    await tx.insert(juniorInboxSnoozeTriggers).values({
      eventType: NEW_ITEM_EVENT_TYPE,
      identifier: input.subject.conversationId,
      namespace: CORE_EVENT_NAMESPACE,
      outcome: "wake",
      snoozeId: snooze!.id,
    });
    return snooze!;
  });
}

/**
 * Undo this User's active snoozes on an Inbox row: with `reviewItemId`, the
 * snooze of that item; without it, every snooze in the root Conversation.
 * Return the number undone.
 */
export async function unsnoozeInboxRow(
  db: JuniorDatabase,
  input: { userId: string; subject: InboxSnoozeSubject },
): Promise<number> {
  const rows = await db
    .update(juniorInboxSnoozes)
    .set({ status: "cancelled", reason: SNOOZE_REASON.unsnoozed })
    .where(
      and(
        eq(juniorInboxSnoozes.userId, input.userId),
        eq(juniorInboxSnoozes.status, "active"),
        eq(juniorInboxSnoozes.conversationId, input.subject.conversationId),
        input.subject.reviewItemId
          ? eq(juniorInboxSnoozes.reviewItemId, input.subject.reviewItemId)
          : undefined,
      ),
    )
    .returning({ id: juniorInboxSnoozes.id });
  return rows.length;
}

/**
 * Wake every snooze on the Inbox rows of a new Review item: any new item in
 * the row's Conversation wakes it, whoever it is for. Run it in the
 * transaction that adds the item.
 */
export async function wakeInboxSnoozesForNewItem(
  db: JuniorDatabase,
  input: { itemId: string; nowMs: number },
): Promise<void> {
  const triggered = queries
    .select({ id: juniorInboxSnoozeTriggers.snoozeId })
    .from(juniorInboxSnoozeTriggers)
    .where(
      and(
        eq(juniorInboxSnoozeTriggers.namespace, CORE_EVENT_NAMESPACE),
        inArray(
          juniorInboxSnoozeTriggers.identifier,
          rowRootsOfItem(input.itemId),
        ),
        eq(juniorInboxSnoozeTriggers.eventType, NEW_ITEM_EVENT_TYPE),
        eq(juniorInboxSnoozeTriggers.outcome, "wake"),
      ),
    );
  // Only an active snooze changes, so the first trigger to fire wins.
  await db
    .update(juniorInboxSnoozes)
    .set({ status: "woken", reason: SNOOZE_REASON.newItem })
    .where(
      and(inArray(juniorInboxSnoozes.id, triggered), asleepAt(input.nowMs)),
    );
}

/**
 * Settle the snoozes whose wake time has passed. Reads already treat them as
 * woken; this only records it. Returns the number settled.
 */
export async function settleDueInboxSnoozes(
  db: JuniorDatabase,
  nowMs: number,
): Promise<number> {
  const due = db
    .select({ id: juniorInboxSnoozes.id })
    .from(juniorInboxSnoozes)
    .where(
      and(
        eq(juniorInboxSnoozes.status, "active"),
        lte(juniorInboxSnoozes.wakeAtMs, nowMs),
      ),
    )
    .limit(SNOOZE_BATCH_LIMIT);
  const rows = await db
    .update(juniorInboxSnoozes)
    .set({ status: "woken", reason: SNOOZE_REASON.time })
    .where(
      and(
        inArray(juniorInboxSnoozes.id, due),
        eq(juniorInboxSnoozes.status, "active"),
      ),
    )
    .returning({ id: juniorInboxSnoozes.id });
  return rows.length;
}

/**
 * Delete snoozes that left `active`, with their triggers, after retention.
 * Returns the number deleted.
 */
export async function deleteExpiredInboxSnoozes(
  db: JuniorDatabase,
  nowMs: number,
): Promise<number> {
  const expired = db
    .select({ id: juniorInboxSnoozes.id })
    .from(juniorInboxSnoozes)
    .where(
      and(
        ne(juniorInboxSnoozes.status, "active"),
        lt(juniorInboxSnoozes.createdAt, new Date(nowMs - SNOOZE_RETENTION_MS)),
      ),
    )
    .limit(SNOOZE_BATCH_LIMIT);
  const rows = await db
    .delete(juniorInboxSnoozes)
    .where(inArray(juniorInboxSnoozes.id, expired))
    .returning({ id: juniorInboxSnoozes.id });
  return rows.length;
}

/**
 * SQL: the Review item is in the Inbox row of this root Conversation. Use it
 * to check that a viewer can see a row before they snooze it.
 */
export function reviewItemInRow(rootConversationId: string): SQL {
  return sql`${rootConversationId} in ${rowRootsOfItem(sql`${juniorReviewItems.id}`)}`;
}
