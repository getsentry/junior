import { z } from "zod";
import { getSlackBotToken } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { createSlackActor, type SlackActor } from "@/chat/actor";
import { parseAvatarUrl } from "@/chat/identities/avatar";

interface SlackUserLookupResult {
  userName?: string;
  fullName?: string;
  email?: string;
  /**
   * The photo that the person set. Slack's default photo is not included.
   * Do not copy it onto the Actor.
   */
  avatarUrl?: string;
  /** Slack profile timezone. Do not copy it onto the Actor. */
  timezone?: string;
}

const slackUserInfoSchema = z.object({
  ok: z.literal(true),
  user: z.object({
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
