import type { JuniorDatabase } from "@/db/db";
import { readUserTimezone, saveUserTimezone } from "@/chat/identities/sql";
import { defaultTimezone } from "@/chat/identities/timezone";
import { isValidTimeZone } from "@/chat/scheduled-automations/cadence";
import { lookupSlackUser } from "@/chat/slack/user";
import type { NotificationSchedule } from "./schedule";
import { linkedSlackUser } from "./slack";

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
  const slack = await linkedSlackUser(args.db, args.userId);
  const slackTimezone = slack
    ? (await lookupSlackUser(slack.teamId, slack.userId))?.timezone
    : undefined;
  if (slackTimezone && isValidTimeZone(slackTimezone)) {
    await saveUserTimezone(args.db, args.userId, slackTimezone, args.nowMs);
    return { source: "slack", timezone: slackTimezone };
  }
  const saved = await readUserTimezone(args.db, args.userId);
  if (saved && isValidTimeZone(saved)) {
    return { source: "saved", timezone: saved };
  }
  return { source: "default", timezone: defaultTimezone() };
}
