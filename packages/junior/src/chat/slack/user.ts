import pLimit from "p-limit";
import * as z from "zod";
import { getSlackBotToken } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { createSlackActor, type SlackActor } from "@/chat/actor";
import { parseAvatarUrl } from "@/chat/identities/avatar";
import {
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";

interface SlackUserLookupResult {
  userName?: string | undefined;
  fullName?: string | undefined;
  email?: string | undefined;
  /**
   * The photo that the person set. Slack's default photo is not included.
   * Do not copy it onto the Actor.
   */
  avatarUrl?: string;
  /** Slack profile timezone. Do not copy it onto the Actor. */
  timezone?: string | undefined;
  /**
   * Whether the person is a Slack guest, who sees only the channels they
   * are in. Unset when Slack did not say.
   */
  isGuest?: boolean;
}

const slackUserInfoSchema = z.object({
  ok: z.literal(true),
  user: z.object({
    is_restricted: z.boolean().nullish(),
    is_ultra_restricted: z.boolean().nullish(),
    name: z.string().nullish(),
    tz: z.string().nullish(),
    profile: z
      .object({
        email: z.string().nullish(),
        image_512: z.string().nullish(),
        is_custom_image: z.boolean().nullish(),
        real_name: z.string().nullish(),
      })
      .optional(),
  }),
});

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map<
  string,
  { value: SlackUserLookupResult; expiresAt: number }
>();

function userCacheKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

function readFromCache(
  teamId: string,
  userId: string,
): SlackUserLookupResult | null {
  const hit = userCache.get(userCacheKey(teamId, userId));
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    userCache.delete(userCacheKey(teamId, userId));
    return null;
  }
  return hit.value;
}

function writeToCache(
  teamId: string,
  userId: string,
  value: SlackUserLookupResult,
): void {
  userCache.set(userCacheKey(teamId, userId), {
    value,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

/** Fetch Slack user profile info with in-memory TTL cache to avoid repeated API calls. */
export async function lookupSlackUser(
  teamId: string,
  userId?: string,
): Promise<SlackUserLookupResult | null> {
  if (!teamId || !userId) {
    return null;
  }

  const cached = readFromCache(teamId, userId);
  if (cached) {
    return cached;
  }

  const token = getSlackBotToken();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      logWarn("slack.user.lookup.failed", {
        "app.slack.user_id": userId,
        "app.slack.team_id": teamId,
        "http.response.status_code": response.status,
      });
      return null;
    }

    const parsed = slackUserInfoSchema.safeParse(await response.json());
    if (!parsed.success) {
      return null;
    }
    const payload = parsed.data;
    const userName = payload.user.name?.trim() || undefined;
    const fullName = payload.user.profile?.real_name?.trim() || undefined;
    const avatarUrl = payload.user.profile?.is_custom_image
      ? parseAvatarUrl(payload.user.profile.image_512, "slack")
      : undefined;

    const result: SlackUserLookupResult = {
      userName,
      fullName,
      email: payload.user.profile?.email?.trim() || undefined,
      ...(avatarUrl ? { avatarUrl } : undefined),
      timezone: payload.user.tz?.trim() || undefined,
    };
    const { is_restricted, is_ultra_restricted } = payload.user;
    if (
      typeof is_restricted === "boolean" &&
      typeof is_ultra_restricted === "boolean"
    ) {
      result.isGuest = is_restricted || is_ultra_restricted;
    }
    writeToCache(teamId, userId, result);
    return result;
  } catch (error) {
    logWarn("slack.user.lookup.failed", {
      "app.slack.user_id": userId,
      "app.slack.team_id": teamId,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Resolve the canonical Slack actor from Slack profile data. */
export async function lookupSlackActor(
  teamId: string,
  userId: string,
): Promise<SlackActor> {
  return createSlackActor(
    teamId,
    userId,
    await lookupSlackUser(teamId, userId),
  );
}

/** Names that the dashboard shows for a mentioned Slack user. */
export interface SlackUserNames {
  fullName?: string | undefined;
  userName?: string | undefined;
}

// Most dashboard reads run on an instance that has never seen the user, so
// the process cache above rarely hits. A shared state entry lets every
// instance skip `users.info` for a day. Names change rarely. Only answers
// from Slack are shared, so a failed lookup stays local to one request.
const USER_NAMES_SHARED_TTL_MS = 24 * 60 * 60 * 1000;
// Caps parallel `users.info` calls so a cold read with many mentions does
// not burst past the Slack rate limit.
const USER_NAMES_LOOKUP_CONCURRENCY = 5;

const sharedUserNamesSchema = z.object({
  fullName: z.string().optional(),
  userName: z.string().optional(),
});

function sharedUserNamesKey(teamId: string, userId: string): string {
  return `slack-user-names:${teamId}:${userId}`;
}

/**
 * Look up the names of Slack users in one workspace, shared across instances.
 * A user is missing from the result when Slack has no answer for them.
 */
export async function lookupSlackUserNames(
  teamId: string,
  userIds: readonly string[],
): Promise<Map<string, SlackUserNames>> {
  const names = new Map<string, SlackUserNames>();
  if (userIds.length === 0) return names;

  const state = getStateAdapter();
  const shared = await getStateValues(
    state,
    userIds.map((userId) => sharedUserNamesKey(teamId, userId)),
  );
  const missing: string[] = [];
  for (const [index, userId] of userIds.entries()) {
    const parsed = sharedUserNamesSchema.safeParse(shared[index]);
    if (parsed.success) {
      names.set(userId, parsed.data);
    } else {
      missing.push(userId);
    }
  }

  const limit = pLimit(USER_NAMES_LOOKUP_CONCURRENCY);
  const profiles = await Promise.all(
    missing.map((userId) => limit(() => lookupSlackUser(teamId, userId))),
  );
  const found: Array<{ key: string; value: SlackUserNames }> = [];
  for (const [index, userId] of missing.entries()) {
    const profile = profiles[index];
    if (!profile) continue;
    const value: SlackUserNames = {
      ...(profile.fullName ? { fullName: profile.fullName } : undefined),
      ...(profile.userName ? { userName: profile.userName } : undefined),
    };
    names.set(userId, value);
    found.push({ key: sharedUserNamesKey(teamId, userId), value });
  }
  await setStateValues(state, found, USER_NAMES_SHARED_TTL_MS);
  return names;
}
