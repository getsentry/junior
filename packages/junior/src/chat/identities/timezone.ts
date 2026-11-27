import type { JuniorDatabase } from "@/db/db";
import type { Actor } from "@/chat/actor";
import { getChatConfig } from "@/chat/config";
import {
  linkedSlackUser,
  readUserTimezone,
  saveUserTimezone,
} from "@/chat/identities/sql";
import { isValidTimeZone } from "@/chat/scheduled-automations/cadence";
import { lookupSlackUser } from "@/chat/slack/user";

/** A known timezone and where it came from. */
interface UserTimezone {
  source: "slack" | "saved";
  timezone: string;
}

/** The install timezone, used when Junior does not know a person's timezone. */
export function defaultTimezone(): string {
  return getChatConfig().deployment.timezone;
}

/**
 * Find a person's timezone: their Slack profile, then the saved user
 * timezone. Slack is the source of truth. A valid Slack timezone is saved on
 * the linked user, so surfaces without Slack still find it. Returns
 * undefined when neither is known.
 */
export async function findUserTimezone(args: {
  db: JuniorDatabase;
  nowMs: number;
  slack?: { teamId: string; userId: string } | undefined;
  userId?: string | undefined;
}): Promise<UserTimezone | undefined> {
  const profile = args.slack
    ? await lookupSlackUser(args.slack.teamId, args.slack.userId)
    : undefined;
  const timezone = profile?.timezone;
  if (timezone && isValidTimeZone(timezone)) {
    if (args.userId) {
      await saveUserTimezone(args.db, args.userId, timezone, args.nowMs);
    }
    return { source: "slack", timezone };
  }
  const saved = args.userId
    ? await readUserTimezone(args.db, args.userId)
    : undefined;
  return saved && isValidTimeZone(saved)
    ? { source: "saved", timezone: saved }
    : undefined;
}

/**
 * Pick a person's timezone with `findUserTimezone`, then fall back to the
 * install default.
 */
export async function resolveUserTimezone(args: {
  db: JuniorDatabase;
  nowMs: number;
  slack?: { teamId: string; userId: string };
  userId?: string;
}): Promise<string> {
  return (await findUserTimezone(args))?.timezone ?? defaultTimezone();
}

/**
 * Find the timezone of the person who sent a Turn, on Slack or the web. A
 * web Actor uses the Slack user linked to its User. Returns undefined when
 * it is not known, so the prompt never shows the install default as theirs.
 */
export async function findActorTimezone(args: {
  actor: Actor | undefined;
  db: JuniorDatabase;
  nowMs: number;
  /** Return the id of the User linked to the Actor. */
  resolveUserId: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const { actor } = args;
  if (actor?.platform === "slack") {
    return (
      await findUserTimezone({
        db: args.db,
        nowMs: args.nowMs,
        slack: { teamId: actor.teamId, userId: actor.userId },
        userId: await args.resolveUserId(),
      })
    )?.timezone;
  }
  if (actor?.platform === "web") {
    // Junior is the web provider, so the web Actor id is the User id.
    return (
      await findUserTimezone({
        db: args.db,
        nowMs: args.nowMs,
        slack: await linkedSlackUser(args.db, actor.userId),
        userId: actor.userId,
      })
    )?.timezone;
  }
  return undefined;
}
