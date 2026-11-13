import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { logWarn } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomations } from "@/db/schema/automations";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorIdentities } from "@/db/schema/identities";
import {
  juniorReviewItemConversations,
  juniorReviewItems,
} from "@/db/schema/review-items";
import {
  WAKE_TIMER_EVENT_TYPE,
  wakeAutomationRecordSchema,
  wakeEventTrigger,
  wakeTimerTrigger,
  type WakeAutomation,
  type WakeSubject,
  type WakeTrigger,
} from "./types";

type AutomationRow = typeof juniorAutomations.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A completed Snooze is deleted this long after it was created. */
const WAKE_AUTOMATION_RETENTION_MS = 30 * DAY_MS;
// Bound one heartbeat or retention pass. The rest waits for the next one;
// reads already treat a due timer as fired.
const WAKE_BATCH_LIMIT = 1000;

/** Why a wake Automation completed. An Event wake stores its event type. */
const WAKE_REASON = {
  newItem: "new_item",
  replaced: "replaced",
  timer: WAKE_TIMER_EVENT_TYPE,
  unsnoozed: "unsnoozed",
} as const;

const linkRoot = alias(juniorConversations, "wake_link_root");
const itemLink = alias(juniorReviewItemConversations, "wake_item_link");

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

/** SQL: the wake has not fired yet, so its row stays hidden. */
function asleepAt(nowMs: number): SQL {
  return and(
    eq(juniorAutomations.action, "wake"),
    eq(juniorAutomations.status, "active"),
    // A timer at or before now has fired, even before the heartbeat settles it.
    or(
      isNull(juniorAutomations.nextRunAtMs),
      sql`${juniorAutomations.nextRunAtMs} > ${nowMs}`,
    ),
  )!;
}

/**
 * SQL: this User snoozed the Inbox row of the Review item, and the snooze has
 * not woken. The row is the item itself, or the root Conversation of a
 * Conversation that the item links.
 */
export function reviewItemSnoozedBy(userId: string, nowMs: number): SQL {
  return sql`exists (select 1 from ${juniorAutomations} inner join ${juniorIdentities} on ${juniorIdentities.id} = ${juniorAutomations.creatorIdentityId} where ${juniorIdentities.userId} = ${userId} and ${asleepAt(nowMs)} and (${juniorAutomations.subjectReviewItemId} = ${juniorReviewItems.id} or (${juniorAutomations.subjectReviewItemId} is null and ${juniorAutomations.subjectConversationId} in ${rowRootsOfItem(sql`${juniorReviewItems.id}`)})))`;
}

/**
 * SQL for the Inbox versions token: it changes when this User snoozes a row,
 * or when one of their snoozes wakes or is undone.
 */
export function wakeAutomationsVersion(userId: string): SQL<string> {
  return sql<string>`(select concat_ws(':', count(*) filter (where ${juniorAutomations.status} = 'active'), max(${juniorAutomations.createdAtMs})) from ${juniorAutomations} inner join ${juniorIdentities} on ${juniorIdentities.id} = ${juniorAutomations.creatorIdentityId} where ${juniorIdentities.userId} = ${userId} and ${juniorAutomations.action} = 'wake')`;
}

/** Decode a wake row. Log and skip a row that does not parse. */
export function parseWakeAutomationRow(
  row: AutomationRow,
): WakeAutomation | undefined {
  const parsed = wakeAutomationRecordSchema.safeParse(row.record);
  if (!parsed.success) {
    logWarn("wake_automation.row.invalid", {
      "app.task.id": row.id,
      "error.message": parsed.error.message,
    });
    return undefined;
  }
  return {
    ...parsed.data,
    createdAtMs: row.createdAtMs,
    creatorIdentityId: row.creatorIdentityId,
    id: row.id,
    status: row.status === "active" ? "active" : "completed",
    ...(row.statusReason ? { statusReason: row.statusReason } : undefined),
  };
}

/** SQL: active wakes of these identities on this Inbox row. */
function activeWakesOnRow(
  identityIds: readonly string[],
  subject: WakeSubject,
): SQL {
  return and(
    eq(juniorAutomations.action, "wake"),
    eq(juniorAutomations.status, "active"),
    inArray(juniorAutomations.creatorIdentityId, [...identityIds]),
    eq(juniorAutomations.subjectConversationId, subject.conversationId),
    subject.reviewItemId
      ? eq(juniorAutomations.subjectReviewItemId, subject.reviewItemId)
      : isNull(juniorAutomations.subjectReviewItemId),
  )!;
}

/**
 * Snooze one Inbox row: add an active wake Automation. A snooze that the
 * same User already has on the row completes as replaced, so each User has
 * one active snooze per row. `subject.conversationId` must be a root
 * Conversation, and the caller must check that the creator can see the row.
 */
export async function createWakeAutomation(
  db: JuniorDatabase,
  input: {
    creatorIdentityId: string;
    /** Every identity of the creator's User. */
    identityIds: readonly string[];
    nowMs: number;
    subject: WakeSubject;
    triggers: WakeTrigger[];
  },
): Promise<WakeAutomation> {
  const record = wakeAutomationRecordSchema.parse({
    action: "wake",
    subject: input.subject,
    triggers: input.triggers,
  });
  const event = wakeEventTrigger(record.triggers);
  const timer = wakeTimerTrigger(record.triggers);
  return db.transaction(async (tx) => {
    await tx
      .update(juniorAutomations)
      .set({ status: "completed", statusReason: WAKE_REASON.replaced })
      .where(activeWakesOnRow(input.identityIds, record.subject));
    const [row] = await tx
      .insert(juniorAutomations)
      .values({
        action: "wake",
        createdAtMs: input.nowMs,
        creatorIdentityId: input.creatorIdentityId,
        id: randomUUID(),
        identifier: event?.identifier ?? null,
        kind: event ? "event" : "scheduled",
        namespace: event?.namespace ?? null,
        nextRunAtMs: timer ? Date.parse(timer.firesAt) : null,
        record,
        status: "active",
        subjectConversationId: record.subject.conversationId,
        subjectReviewItemId: record.subject.reviewItemId ?? null,
      })
      .returning();
    return parseWakeAutomationRow(row!)!;
  });
}

/**
 * Undo one snooze of these identities. Return false when it is not theirs or
 * has already woken.
 */
export async function unsnoozeWakeAutomation(
  db: JuniorDatabase,
  input: { id: string; identityIds: readonly string[] },
): Promise<boolean> {
  if (input.identityIds.length === 0) return false;
  const rows = await db
    .update(juniorAutomations)
    .set({ status: "completed", statusReason: WAKE_REASON.unsnoozed })
    .where(
      and(
        eq(juniorAutomations.id, input.id),
        eq(juniorAutomations.action, "wake"),
        eq(juniorAutomations.status, "active"),
        inArray(juniorAutomations.creatorIdentityId, [...input.identityIds]),
      ),
    )
    .returning({ id: juniorAutomations.id });
  return rows.length > 0;
}

/**
 * Wake these snoozes for one Event. A snooze whose timer already fired keeps
 * that reason. Idempotent: a woken snooze does not change again.
 */
export async function wakeAutomationsForEvent(
  db: JuniorDatabase,
  input: { eventType: string; ids: readonly string[]; nowMs: number },
): Promise<number> {
  if (input.ids.length === 0) return 0;
  const rows = await db
    .update(juniorAutomations)
    .set({ status: "completed", statusReason: input.eventType })
    .where(
      and(inArray(juniorAutomations.id, [...input.ids]), asleepAt(input.nowMs)),
    )
    .returning({ id: juniorAutomations.id });
  return rows.length;
}

/**
 * Wake every snooze on the Inbox rows of a new Review item: any new item in
 * the row's Conversation wakes it, whoever it is for. Run it in the
 * transaction that adds the item.
 */
export async function wakeAutomationsForNewItem(
  db: JuniorDatabase,
  input: { itemId: string; nowMs: number },
): Promise<void> {
  await db
    .update(juniorAutomations)
    .set({ status: "completed", statusReason: WAKE_REASON.newItem })
    .where(
      and(
        asleepAt(input.nowMs),
        inArray(
          juniorAutomations.subjectConversationId,
          rowRootsOfItem(input.itemId),
        ),
      ),
    );
}

/**
 * Deliver due timer Events to their snoozes, in bulk. Each timer has one
 * consumer, its own snooze, so this needs no Event ingest and no Turn.
 * Returns the number settled.
 */
export async function settleDueWakeAutomations(
  db: JuniorDatabase,
  nowMs: number,
): Promise<number> {
  const due = db
    .select({ id: juniorAutomations.id })
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.action, "wake"),
        eq(juniorAutomations.status, "active"),
        lte(juniorAutomations.nextRunAtMs, nowMs),
      ),
    )
    .limit(WAKE_BATCH_LIMIT);
  const rows = await db
    .update(juniorAutomations)
    .set({ status: "completed", statusReason: WAKE_REASON.timer })
    .where(
      and(
        inArray(juniorAutomations.id, due),
        eq(juniorAutomations.status, "active"),
      ),
    )
    .returning({ id: juniorAutomations.id });
  return rows.length;
}

/** Delete completed snoozes past retention. Returns the number deleted. */
export async function deleteExpiredWakeAutomations(
  db: JuniorDatabase,
  nowMs: number,
): Promise<number> {
  const expired = db
    .select({ id: juniorAutomations.id })
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.action, "wake"),
        eq(juniorAutomations.status, "completed"),
        lt(juniorAutomations.createdAtMs, nowMs - WAKE_AUTOMATION_RETENTION_MS),
      ),
    )
    .limit(WAKE_BATCH_LIMIT);
  const rows = await db
    .delete(juniorAutomations)
    .where(
      and(
        inArray(juniorAutomations.id, expired),
        eq(juniorAutomations.action, "wake"),
      ),
    )
    .returning({ id: juniorAutomations.id });
  return rows.length;
}

/**
 * SQL: the Review item is in the Inbox row of this root Conversation. Use it
 * to check that a viewer can see a row before they snooze it.
 */
export function reviewItemInRow(rootConversationId: string): SQL {
  return sql`${rootConversationId} in ${rowRootsOfItem(sql`${juniorReviewItems.id}`)}`;
}
