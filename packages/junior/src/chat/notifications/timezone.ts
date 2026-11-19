import type { JuniorDatabase } from "@/db/db";
import { linkedSlackUser } from "@/chat/identities/sql";
import { defaultTimezone, findUserTimezone } from "@/chat/identities/timezone";
import { isValidTimeZone } from "@/chat/scheduled-automations/cadence";
import type { NotificationSchedule } from "./schedule";

/** Where the notification timezone came from. */
export type NotificationTimezoneSource =
  | "manual"
  | "slack"
  | "saved"
  | "default";

/**
 * Pick the timezone for a user's notification hours: the timezone saved in
 * the schedule, then the linked Slack profile, then the saved user timezone,
 * then the install default. A valid Slack timezone is saved on the user.
 */
export async function resolveNotificationTimezone(args: {
  db: JuniorDatabase;
  nowMs: number;
  schedule: NotificationSchedule;
  userId: string;
}): Promise<{ source: NotificationTimezoneSource; timezone: string }> {
  if (args.schedule.timezone && isValidTimeZone(args.schedule.timezone)) {
    return { source: "manual", timezone: args.schedule.timezone };
  }
  const found = await findUserTimezone({
    db: args.db,
    nowMs: args.nowMs,
    slack: await linkedSlackUser(args.db, args.userId),
    userId: args.userId,
  });
  return found ?? { source: "default", timezone: defaultTimezone() };
}
