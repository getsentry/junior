import type { JuniorDatabase } from "@/db/db";
import { readUserTimezone, saveUserTimezone } from "@/chat/identities/sql";
import { lookupSlackUser } from "@/chat/slack/user";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** The install timezone, used when Junior does not know a person's timezone. */
export function defaultTimezone(): string {
  return process.env.JUNIOR_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

/** Check that a value is an IANA timezone that this runtime knows. */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a person's timezone: their Slack profile, then the saved user
 * timezone, then the install default. A valid Slack timezone is saved on the
 * linked user, so later lookups without Slack still find it.
 */
export async function resolveUserTimezone(args: {
  db: JuniorDatabase;
  nowMs: number;
  slack?: { teamId: string; userId: string };
  userId?: string;
}): Promise<string> {
  const profile = args.slack
    ? await lookupSlackUser(args.slack.teamId, args.slack.userId)
    : undefined;
  const timezone = profile?.timezone;
  if (timezone && isValidTimeZone(timezone)) {
    if (args.userId) {
      await saveUserTimezone(args.db, args.userId, timezone, args.nowMs);
    }
    return timezone;
  }
  const saved = args.userId
    ? await readUserTimezone(args.db, args.userId)
    : undefined;
  return saved ?? defaultTimezone();
}
