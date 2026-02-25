interface SlackUserLookupResult {
  userName?: string;
  fullName?: string;
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map<string, { value: SlackUserLookupResult; expiresAt: number }>();

function readFromCache(userId: string): SlackUserLookupResult | null {
  const hit = userCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    userCache.delete(userId);
    return null;
  }
  return hit.value;
}

function writeToCache(userId: string, value: SlackUserLookupResult): void {
  userCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_CACHE_TTL_MS
  });
}

export async function lookupSlackUser(userId?: string): Promise<SlackUserLookupResult | null> {
  if (!userId) {
    return null;
  }

  const cached = readFromCache(userId);
  if (cached) {
    return cached;
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
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
      fullName
    };
    writeToCache(userId, result);
    return result;
  } catch {
    return null;
  }
}
