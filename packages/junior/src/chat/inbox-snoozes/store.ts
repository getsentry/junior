import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { EventMatch } from "@sentry/junior-plugin-api";
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

/** A trigger as Event matching reads it. */
export interface InboxSnoozeTriggerMatch {
  eventType: string;
  identifier: string;
  match: EventMatch | null;
  outcome: "wake" | "resolve";
  snoozeId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A snooze that woke or was cancelled is deleted this long after it was made. */
const SNOOZE_RETENTION_MS = 30 * DAY_MS;
// Bound one retention pass. The rest waits for the next one.
const SNOOZE_RETENTION_LIMIT = 1000;

/** The Event of a snooze timer. Its identifier is the timer id. */
export const SNOOZE_TIMER_EVENT_TYPE = "timer.fired";

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

/**
 * SQL: the Review item is in the Inbox row of this root Conversation: the
 * item links that Conversation or one of its threads.
 */
export function reviewItemInRow(rootConversationId: string): SQL {
  return inArray(
    sql`${rootConversationId}`,
    rowRootsOfItem(sql`${juniorReviewItems.id}`),
  );
}

/** SQL: this User snoozed the Review item, and it has not woken. */
export function reviewItemSnoozedBy(userId: string): SQL {
  return sql`exists (select 1 from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${juniorInboxSnoozes.reviewItemId} = ${juniorReviewItems.id} and ${juniorInboxSnoozes.state} = 'snoozed')`;
}

/**
 * SQL for the Inbox versions token: it changes when this User snoozes an
 * item, and when one of their snoozes wakes or is cancelled.
 */
export function inboxSnoozesVersion(userId: string): SQL<string> {
  return sql<string>`(select concat_ws(':', count(*), max(${juniorInboxSnoozes.createdAt})) from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${juniorInboxSnoozes.state} = 'snoozed')`;
}

/**
 * Snooze Review items for one User. Each item gets its own snooze with a
 * timer wake trigger. A new item in the row is not snoozed, so it shows by
 * itself. The User's earlier snooze on an item is cancelled. The caller
 * must check that the User can see each item. Returns the new snoozes.
 */
export async function snoozeInboxItems(
  db: JuniorDatabase,
  input: {
    nowMs: number;
    reviewItemIds: readonly string[];
    timerId: string;
    userId: string;
  },
): Promise<string[]> {
  // Serialize all of one User's snoozes, so overlapping requests replace in
  // turn instead of failing on the unique index. An item can be in the rows
  // of more than one root, so a lock per row is not enough.
  const lockKey = `junior:inbox-snooze:${input.userId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx
      .update(juniorInboxSnoozes)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(juniorInboxSnoozes.userId, input.userId),
          inArray(juniorInboxSnoozes.reviewItemId, [...input.reviewItemIds]),
          eq(juniorInboxSnoozes.state, "snoozed"),
        ),
      );
    const snoozes = input.reviewItemIds.map((reviewItemId) => ({
      createdAt: new Date(input.nowMs),
      id: randomUUID(),
      reviewItemId,
      state: "snoozed" as const,
      userId: input.userId,
    }));
    await tx.insert(juniorInboxSnoozes).values(snoozes);
    await tx.insert(juniorInboxSnoozeTriggers).values(
      snoozes.flatMap((snooze) => [
        {
          eventType: SNOOZE_TIMER_EVENT_TYPE,
          identifier: input.timerId,
          namespace: CORE_EVENT_NAMESPACE,
          outcome: "wake" as const,
          snoozeId: snooze.id,
        },
      ]),
    );
    return snoozes.map((snooze) => snooze.id);
  });
}

/**
 * Wake this User's snoozes on the open items of an Inbox row now: one item,
 * or every item in the root Conversation's row.
 */
export async function unsnoozeInboxRow(
  db: JuniorDatabase,
  input: {
    rootConversationId: string;
    reviewItemId?: string;
    userId: string;
  },
): Promise<void> {
  const items = queries
    .select({ id: juniorReviewItems.id })
    .from(juniorReviewItems)
    .where(
      input.reviewItemId
        ? eq(juniorReviewItems.id, input.reviewItemId)
        : reviewItemInRow(input.rootConversationId),
    );
  await db
    .update(juniorInboxSnoozes)
    .set({ state: "woken" })
    .where(
      and(
        eq(juniorInboxSnoozes.userId, input.userId),
        inArray(juniorInboxSnoozes.reviewItemId, items),
        eq(juniorInboxSnoozes.state, "snoozed"),
      ),
    );
}

/**
 * Return the triggers of snoozed items that Events of these types and
 * resources can fire. The caller checks each trigger's `match` against the
 * Event data.
 */
export async function listFiringInboxSnoozeTriggers(
  db: JuniorDatabase,
  input: {
    eventTypes: readonly string[];
    identifiers: readonly string[];
    namespace: string;
  },
): Promise<InboxSnoozeTriggerMatch[]> {
  if (input.identifiers.length === 0 || input.eventTypes.length === 0) {
    return [];
  }
  return db
    .select({
      eventType: juniorInboxSnoozeTriggers.eventType,
      identifier: juniorInboxSnoozeTriggers.identifier,
      match: juniorInboxSnoozeTriggers.match,
      outcome: juniorInboxSnoozeTriggers.outcome,
      snoozeId: juniorInboxSnoozeTriggers.snoozeId,
    })
    .from(juniorInboxSnoozeTriggers)
    .innerJoin(
      juniorInboxSnoozes,
      eq(juniorInboxSnoozes.id, juniorInboxSnoozeTriggers.snoozeId),
    )
    .where(
      and(
        eq(juniorInboxSnoozeTriggers.namespace, input.namespace),
        inArray(juniorInboxSnoozeTriggers.identifier, [...input.identifiers]),
        inArray(juniorInboxSnoozeTriggers.eventType, [...input.eventTypes]),
        eq(juniorInboxSnoozes.state, "snoozed"),
      ),
    );
}

/**
 * End snoozes that a trigger fired. Only a `snoozed` row changes, so the
 * first trigger to fire wins. Return the items of the snoozes that changed.
 */
export async function settleInboxSnoozes(
  db: JuniorDatabase,
  input: { snoozeIds: readonly string[]; state: "woken" | "cancelled" },
): Promise<string[]> {
  if (input.snoozeIds.length === 0) return [];
  const rows = await db
    .update(juniorInboxSnoozes)
    .set({ state: input.state })
    .where(
      and(
        inArray(juniorInboxSnoozes.id, [...input.snoozeIds]),
        eq(juniorInboxSnoozes.state, "snoozed"),
      ),
    )
    .returning({ reviewItemId: juniorInboxSnoozes.reviewItemId });
  return rows.map((row) => row.reviewItemId);
}

/**
 * Delete snoozes that woke or were cancelled, with their triggers, after
 * retention. Returns the number deleted.
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
        ne(juniorInboxSnoozes.state, "snoozed"),
        lt(juniorInboxSnoozes.createdAt, new Date(nowMs - SNOOZE_RETENTION_MS)),
      ),
    )
    .limit(SNOOZE_RETENTION_LIMIT);
  const rows = await db
    .delete(juniorInboxSnoozes)
    .where(inArray(juniorInboxSnoozes.id, expired))
    .returning({ id: juniorInboxSnoozes.id });
  return rows.length;
}
