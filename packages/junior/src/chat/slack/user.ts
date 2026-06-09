import { getSlackBotToken } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { createSlackRequester, type Requester } from "@/chat/requester";

interface SlackUserLookupResult {
  userName?: string;
  fullName?: string;
  email?: string;
}

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
      logWarn(
        "slack_user_lookup_failed",
        {},
        {
          "enduser.id": userId,
          "app.slack.team_id": teamId,
          "http.response.status_code": response.status,
        },
        "Slack user lookup request failed",
      );
      return null;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      user?: {
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
          email?: string;
        };
      };
    };

    if (!payload.ok || !payload.user) {
      return null;
    }

    const userName = payload.user.name?.trim() || undefined;
    const fullName =
      payload.user.profile?.display_name?.trim() ||
      payload.user.profile?.real_name?.trim() ||
      payload.user.real_name?.trim() ||
      undefined;

    const result: SlackUserLookupResult = {
      userName,
      fullName,
      email: payload.user.profile?.email?.trim() || undefined,
    };
    writeToCache(teamId, userId, result);
    return result;
  } catch (error) {
    logWarn(
      "slack_user_lookup_failed",
      {},
      {
        "enduser.id": userId,
        "app.slack.team_id": teamId,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      },
      "Slack user lookup failed with exception",
    );
    return null;
  }
}

/** Resolve the canonical Slack requester from Slack profile data. */
export async function lookupSlackRequester(
  teamId: string,
  userId: string,
): Promise<Requester> {
  return createSlackRequester(
    teamId,
    userId,
    await lookupSlackUser(teamId, userId),
  );
}
