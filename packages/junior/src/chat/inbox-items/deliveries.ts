import { and, desc, eq, gt, inArray, max } from "drizzle-orm";
import type { NotificationPause } from "@/chat/notifications/pause";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemDeliveries } from "@/db/schema";

/**
 * Why a delivery sent nothing. `taken`: the User took the item themselves,
 * so they already know about it. `slack_active`: the User was active in
 * Slack after its card posted, so Slack's own notification reached them.
 */
export type InboxItemDeliverySkipReason =
  | NotificationPause
  | "slack_active"
  | "snoozed"
  | "taken";

/** Keep at most this many closed items in one push. */
const MAX_CLEARED_ITEMS = 20;

/** Return the Users that already have the `created` web push of an item. */
export async function listInboxItemPushUserIds(
  db: JuniorDatabase,
  itemId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ userId: juniorInboxItemDeliveries.userId })
    .from(juniorInboxItemDeliveries)
    .where(
      and(
        eq(juniorInboxItemDeliveries.itemId, itemId),
        eq(juniorInboxItemDeliveries.channel, "web_push"),
        eq(juniorInboxItemDeliveries.event, "created"),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}

/**
 * Record the `created` web push of one item to one User. Return false when
 * a row already exists, so only the first caller sends.
 */
export async function claimInboxItemPush(
  db: JuniorDatabase,
  input: {
    itemId: string;
    nowMs: number;
    skipReason: InboxItemDeliverySkipReason | undefined;
    userId: string;
  },
): Promise<boolean> {
  const now = new Date(input.nowMs);
  const inserted = await db
    .insert(juniorInboxItemDeliveries)
    .values({
      channel: "web_push",
      createdAt: now,
      event: "created",
      itemId: input.itemId,
      skipReason: input.skipReason ?? null,
      status: input.skipReason ? "skipped" : "sent",
      updatedAt: now,
      userId: input.userId,
    })
    .onConflictDoNothing()
    .returning({ itemId: juniorInboxItemDeliveries.itemId });
  return inserted.length > 0;
}

/**
 * Record that a Slack card shows an item to these Users, once per User.
 * Return when each of them first got a card, so their wait for a push
 * starts then, also after a later show of the item.
 */
export async function recordInboxItemSlackCard(
  db: JuniorDatabase,
  input: { itemId: string; nowMs: number; userIds: readonly string[] },
): Promise<Map<string, number>> {
  if (input.userIds.length === 0) return new Map();
  const now = new Date(input.nowMs);
  await db
    .insert(juniorInboxItemDeliveries)
    .values(
      input.userIds.map((userId) => ({
        channel: "slack" as const,
        createdAt: now,
        event: "created" as const,
        itemId: input.itemId,
        status: "sent" as const,
        updatedAt: now,
        userId,
      })),
    )
    .onConflictDoNothing();
  const rows = await db
    .select({
      createdAt: juniorInboxItemDeliveries.createdAt,
      userId: juniorInboxItemDeliveries.userId,
    })
    .from(juniorInboxItemDeliveries)
    .where(
      and(
        eq(juniorInboxItemDeliveries.itemId, input.itemId),
        eq(juniorInboxItemDeliveries.channel, "slack"),
        eq(juniorInboxItemDeliveries.event, "created"),
        inArray(juniorInboxItemDeliveries.userId, [...input.userIds]),
      ),
    );
  return new Map(rows.map((row) => [row.userId, row.createdAt.getTime()]));
}

/**
 * Record a web push that can repeat for one item and User: a reply to its
 * starter, or the wake of their snooze. Each one pushes again, so the one
 * record of the event holds the latest push. A skipped push keeps an
 * earlier `sent` record: that notification still shows, and the close of
 * the item must clear it.
 */
export async function recordRepeatInboxItemPush(
  db: JuniorDatabase,
  input: {
    event: "reply" | "wake";
    itemId: string;
    nowMs: number;
    skipReason: InboxItemDeliverySkipReason | undefined;
    userId: string;
  },
): Promise<void> {
  const now = new Date(input.nowMs);
  const result = {
    skipReason: input.skipReason ?? null,
    status: input.skipReason ? ("skipped" as const) : ("sent" as const),
    updatedAt: now,
  };
  const insert = db.insert(juniorInboxItemDeliveries).values({
    ...result,
    channel: "web_push",
    createdAt: now,
    event: input.event,
    itemId: input.itemId,
    userId: input.userId,
  });
  if (input.skipReason) {
    await insert.onConflictDoNothing();
    return;
  }
  await insert.onConflictDoUpdate({
    target: [
      juniorInboxItemDeliveries.itemId,
      juniorInboxItemDeliveries.userId,
      juniorInboxItemDeliveries.channel,
      juniorInboxItemDeliveries.event,
    ],
    set: result,
  });
}

/**
 * Mark the sent deliveries of items as cleared: items that closed, or a
 * To-do item that moved to another User.
 */
export async function clearInboxItemDeliveries(
  db: JuniorDatabase,
  itemIds: readonly string[],
  nowMs: number,
): Promise<void> {
  if (itemIds.length === 0) return;
  await db
    .update(juniorInboxItemDeliveries)
    .set({ status: "cleared", updatedAt: new Date(nowMs) })
    .where(
      and(
        inArray(juniorInboxItemDeliveries.itemId, [...itemIds]),
        eq(juniorInboxItemDeliveries.status, "sent"),
      ),
    );
}

/**
 * Return the items whose web push to this User cleared after `sinceMs`,
 * newest first. A device can still show them, so the next push closes them.
 * An item can have more than one push, such as its creation and a wake, but
 * shows as one notification, so it is listed once.
 */
export async function listClearedInboxItemPushes(
  db: JuniorDatabase,
  userId: string,
  sinceMs: number,
): Promise<string[]> {
  const rows = await db
    .select({ itemId: juniorInboxItemDeliveries.itemId })
    .from(juniorInboxItemDeliveries)
    .where(
      and(
        eq(juniorInboxItemDeliveries.userId, userId),
        eq(juniorInboxItemDeliveries.channel, "web_push"),
        eq(juniorInboxItemDeliveries.status, "cleared"),
        gt(juniorInboxItemDeliveries.updatedAt, new Date(sinceMs)),
      ),
    )
    .groupBy(juniorInboxItemDeliveries.itemId)
    .orderBy(desc(max(juniorInboxItemDeliveries.updatedAt)))
    .limit(MAX_CLEARED_ITEMS);
  return rows.map((row) => row.itemId);
}
