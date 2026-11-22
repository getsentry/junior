import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { NotificationPause } from "@/chat/notifications/pause";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemDeliveries } from "@/db/schema";

/** Why a delivery sent nothing. */
export type InboxItemDeliverySkipReason = NotificationPause | "snoozed";

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

/** Mark the sent deliveries of closed items as cleared. */
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
    .orderBy(desc(juniorInboxItemDeliveries.updatedAt))
    .limit(MAX_CLEARED_ITEMS);
  return rows.map((row) => row.itemId);
}
