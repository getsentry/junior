import type { JuniorDatabase } from "@/db/db";
import { isWithinNotificationSchedule } from "./schedule";
import { isPausedBySlack } from "./slack";
import { readNotificationSchedule } from "./store";
import { resolveNotificationTimezone } from "./timezone";

/** Why a push to a User waits for later or never sends. */
export type NotificationPause = "outside_hours" | "slack_paused";

/**
 * Return why pushes to this User are paused now, or undefined when Junior
 * can push. By default the linked Slack user's notification schedule
 * decides. The saved hours apply when the User turns that off or Slack
 * cannot answer.
 */
export async function readNotificationPause(
  db: JuniorDatabase,
  userId: string,
  nowMs: number,
): Promise<NotificationPause | undefined> {
  const schedule = await readNotificationSchedule(db, userId);
  const pausedBySlack =
    schedule.followSlack !== false
      ? await isPausedBySlack(db, userId, nowMs)
      : undefined;
  if (pausedBySlack) return "slack_paused";
  if (pausedBySlack !== undefined) return undefined;
  const { timezone } = await resolveNotificationTimezone({
    db,
    nowMs,
    schedule,
    userId,
  });
  return isWithinNotificationSchedule(schedule, timezone, nowMs)
    ? undefined
    : "outside_hours";
}
