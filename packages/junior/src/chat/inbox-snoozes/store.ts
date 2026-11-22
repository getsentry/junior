import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { EventMatch } from "@sentry/junior-plugin-api";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema/conversations";
import {
  juniorInboxSnoozes,
  juniorInboxSnoozeTriggers,
  type InboxSnoozeWakeReason,
} from "@/db/schema/inbox-snoozes";
import {
  juniorInboxItemConversations,
  juniorInboxItems,
} from "@/db/schema/inbox-items";

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
const itemLink = alias(juniorInboxItemConversations, "snooze_item_link");

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
 * SQL: the Inbox item is in the Inbox row of this root Conversation: the
 * item links that Conversation or one of its threads.
 */
export function inboxItemInRow(rootConversationId: string): SQL {
  return inArray(
    sql`${rootConversationId}`,
    rowRootsOfItem(sql`${juniorInboxItems.id}`),
  );
}

/** SQL: this User snoozed the Inbox item, and it has not woken. */
export function inboxItemSnoozedBy(userId: string): SQL {
  return sql`exists (select 1 from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${juniorInboxSnoozes.inboxItemId} = ${juniorInboxItems.id} and ${juniorInboxSnoozes.state} = 'snoozed')`;
}

/**
 * SQL for the Inbox versions token: it changes when this User snoozes an
 * item, and when one of their snoozes wakes or is cancelled.
 */
export function inboxSnoozesVersion(userId: string): SQL<string> {
  return sql<string>`(select concat_ws(':', count(*), max(${juniorInboxSnoozes.createdAt})) from ${juniorInboxSnoozes} where ${juniorInboxSnoozes.userId} = ${userId} and ${juniorInboxSnoozes.state} = 'snoozed')`;
}

/**
 * Serialize all of one User's snooze changes for the rest of the
 * transaction. Overlapping snoozes then replace in turn instead of failing
 * on the unique index, and a wake sees the snoozes that a replace made. An
 * item can be in the rows of more than one root, so a lock per row is not
 * enough.
 */
async function lockUserSnoozes(
  tx: Pick<JuniorDatabase, "execute">,
  userId: string,
): Promise<void> {
  const lockKey = `junior:inbox-snooze:${userId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

/** An Event that ends a new snooze. */
export interface InboxSnoozeTriggerInput {
  eventType: string;
  identifier: string;
  namespace: string;
  outcome: "wake" | "resolve";
}

/** The trigger of a snooze timer: its `timer.fired` Event wakes the item. */
export function snoozeTimerTrigger(timerId: string): InboxSnoozeTriggerInput {
  return {
    eventType: SNOOZE_TIMER_EVENT_TYPE,
    identifier: timerId,
    namespace: CORE_EVENT_NAMESPACE,
    outcome: "wake",
  };
}

/**
 * Snooze Inbox items for one User. Each item gets its own snooze with its
 * own triggers. A new item in the row is not snoozed, so it shows by
 * itself. The User's earlier snooze on an item is cancelled. The caller
 * must check that the User can see each item. Returns the new snoozes.
 */
export async function snoozeInboxItems(
  db: JuniorDatabase,
  input: {
    items: readonly {
      inboxItemId: string;
      triggers: readonly InboxSnoozeTriggerInput[];
    }[];
    nowMs: number;
    userId: string;
  },
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockUserSnoozes(tx, input.userId);
    const inboxItemIds = input.items.map((item) => item.inboxItemId);
    await tx
      .update(juniorInboxSnoozes)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(juniorInboxSnoozes.userId, input.userId),
          inArray(juniorInboxSnoozes.inboxItemId, inboxItemIds),
          eq(juniorInboxSnoozes.state, "snoozed"),
        ),
      );
    // A new snooze replaces the reason that the last one woke.
    await clearInboxWakeReasons(tx, { inboxItemIds, userId: input.userId });
    const snoozes = input.items.map((item) => ({
      createdAt: new Date(input.nowMs),
      id: randomUUID(),
      inboxItemId: item.inboxItemId,
      state: "snoozed" as const,
      userId: input.userId,
    }));
    await tx.insert(juniorInboxSnoozes).values(snoozes);
    await tx.insert(juniorInboxSnoozeTriggers).values(
      input.items.flatMap((item, index) =>
        item.triggers.map((trigger) => ({
          ...trigger,
          snoozeId: snoozes[index]!.id,
        })),
      ),
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
  input: ({ inboxItemId: string } | { rootConversationId: string }) & {
    userId: string;
  },
): Promise<void> {
  const items = queries
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      "inboxItemId" in input
        ? eq(juniorInboxItems.id, input.inboxItemId)
        : inboxItemInRow(input.rootConversationId),
    );
  await db.transaction(async (tx) => {
    await lockUserSnoozes(tx, input.userId);
    await tx
      .update(juniorInboxSnoozes)
      .set({ state: "woken" })
      .where(
        and(
          eq(juniorInboxSnoozes.userId, input.userId),
          inArray(juniorInboxSnoozes.inboxItemId, items),
          eq(juniorInboxSnoozes.state, "snoozed"),
        ),
      );
  });
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
 * first trigger to fire wins. A woken snooze records why it woke. Return
 * the items of the snoozes that changed.
 */
export async function settleInboxSnoozes(
  db: Pick<JuniorDatabase, "update">,
  input: { snoozeIds: readonly string[] } & (
    | { state: "cancelled" }
    | { reason: InboxSnoozeWakeReason; state: "woken" }
  ),
): Promise<string[]> {
  if (input.snoozeIds.length === 0) return [];
  const rows = await db
    .update(juniorInboxSnoozes)
    .set(
      input.state === "woken"
        ? { state: input.state, wakeReason: input.reason }
        : { state: input.state },
    )
    .where(
      and(
        inArray(juniorInboxSnoozes.id, [...input.snoozeIds]),
        eq(juniorInboxSnoozes.state, "snoozed"),
      ),
    )
    .returning({ inboxItemId: juniorInboxSnoozes.inboxItemId });
  return rows.map((row) => row.inboxItemId);
}

/**
 * Forget why this User's snoozes of these items woke, once they open or
 * act on the items.
 */
export async function clearInboxWakeReasons(
  db: Pick<JuniorDatabase, "update">,
  input: { inboxItemIds: readonly string[]; userId: string },
): Promise<void> {
  if (input.inboxItemIds.length === 0) return;
  await db
    .update(juniorInboxSnoozes)
    .set({ wakeReason: null })
    .where(
      and(
        eq(juniorInboxSnoozes.userId, input.userId),
        inArray(juniorInboxSnoozes.inboxItemId, [...input.inboxItemIds]),
        isNotNull(juniorInboxSnoozes.wakeReason),
      ),
    );
}

/**
 * Read why this User's snoozes of these items woke, by item id. An item
 * whose snooze the User woke, or whose reason they cleared, has none. A
 * new snooze clears the last reason, so an item has at most one.
 */
export async function readInboxWakeReasons(
  db: Pick<JuniorDatabase, "select">,
  input: { inboxItemIds: readonly string[]; userId: string },
): Promise<Map<string, InboxSnoozeWakeReason>> {
  const reasons = new Map<string, InboxSnoozeWakeReason>();
  if (input.inboxItemIds.length === 0) return reasons;
  const rows = await db
    .select({
      inboxItemId: juniorInboxSnoozes.inboxItemId,
      wakeReason: juniorInboxSnoozes.wakeReason,
    })
    .from(juniorInboxSnoozes)
    .where(
      and(
        eq(juniorInboxSnoozes.userId, input.userId),
        inArray(juniorInboxSnoozes.inboxItemId, [...input.inboxItemIds]),
        eq(juniorInboxSnoozes.state, "woken"),
        isNotNull(juniorInboxSnoozes.wakeReason),
      ),
    );
  for (const row of rows) {
    if (row.wakeReason) reasons.set(row.inboxItemId, row.wakeReason);
  }
  return reasons;
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
