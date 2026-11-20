import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorPushSubscriptions, juniorUsers } from "@/db/schema";
import {
  DEFAULT_NOTIFICATION_SCHEDULE,
  notificationScheduleSchema,
  type NotificationSchedule,
} from "./schedule";

/** Browser Web Push subscription fields that Junior stores. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

/** One stored push subscription. */
export interface StoredPushSubscription extends PushSubscriptionInput {
  id: string;
}

/**
 * Save a browser subscription for a user. The endpoint identifies one browser,
 * so a later sign-in on the same browser moves the row to the new user.
 */
export async function savePushSubscription(
  db: JuniorDatabase,
  userId: string,
  subscription: PushSubscriptionInput,
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  await db
    .insert(juniorPushSubscriptions)
    .values({
      id: randomUUID(),
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: juniorPushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        updatedAt: now,
      },
    });
}

/** Delete one of the user's subscriptions. Return whether a row was deleted. */
export async function deletePushSubscription(
  db: JuniorDatabase,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(juniorPushSubscriptions)
    .where(
      and(
        eq(juniorPushSubscriptions.userId, userId),
        eq(juniorPushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: juniorPushSubscriptions.id });
  return rows.length > 0;
}

/** Delete subscriptions that the push service reports as gone. */
export async function deletePushSubscriptionsById(
  db: JuniorDatabase,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .delete(juniorPushSubscriptions)
    .where(inArray(juniorPushSubscriptions.id, [...ids]));
}

/** List every subscription for one user. */
export async function listPushSubscriptions(
  db: JuniorDatabase,
  userId: string,
): Promise<StoredPushSubscription[]> {
  const rows = await db
    .select()
    .from(juniorPushSubscriptions)
    .where(eq(juniorPushSubscriptions.userId, userId));
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    keys: { auth: row.auth, p256dh: row.p256dh },
  }));
}

/** Read a user's notification hours, or the default when none are saved. */
export async function readNotificationSchedule(
  db: JuniorDatabase,
  userId: string,
): Promise<NotificationSchedule> {
  const rows = await db
    .select({ schedule: juniorUsers.notificationSchedule })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  const parsed = notificationScheduleSchema.safeParse(rows[0]?.schedule);
  return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_SCHEDULE;
}

/** Save a user's notification hours. Return false when the user is missing. */
export async function saveNotificationSchedule(
  db: JuniorDatabase,
  userId: string,
  schedule: NotificationSchedule,
  nowMs: number,
): Promise<boolean> {
  const rows = await db
    .update(juniorUsers)
    .set({ notificationSchedule: schedule, updatedAt: new Date(nowMs) })
    .where(eq(juniorUsers.id, userId))
    .returning({ id: juniorUsers.id });
  return rows.length > 0;
}
