import { getSlackBotToken } from "@/chat/config";
import { logWarn } from "@/chat/logging";

interface SlackUserLookupResult {
  userName?: string;
  fullName?: string;
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map<
  string,
  { value: SlackUserLookupResult; expiresAt: number }
>();

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
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

/** Fetch Slack user profile info with in-memory TTL cache to avoid repeated API calls. */
export async function lookupSlackUser(
  userId?: string,
): Promise<SlackUserLookupResult | null> {
  if (!userId) {
    return null;
  }

  const cached = readFromCache(userId);
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
    };
    writeToCache(userId, result);
    return result;
  } catch (error) {
    logWarn(
      "slack_user_lookup_failed",
      {},
      {
        "enduser.id": userId,
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Slack user lookup failed with exception",
    );
    return null;
  }
}

// ── Reverse lookup: name → user ID ───────────────────────────────────────────

interface SlackUserListMember {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
}

interface NameToUserIdCache {
  map: Map<string, string>;
  expiresAt: number;
}

const NAME_TO_USERID_CACHE_TTL_MS = 10 * 60 * 1000;
let nameToUserIdCache: NameToUserIdCache | null = null;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s.]/g, "");
}

async function buildNameToUserIdMap(): Promise<Map<string, string>> {
  const token = getSlackBotToken();
  if (!token) {
    return new Map();
  }

  const map = new Map<string, string>();
  let cursor: string | undefined;

  try {
    do {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const response = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        break;
      }

      const payload = (await response.json()) as {
        ok?: boolean;
        members?: SlackUserListMember[];
        response_metadata?: { next_cursor?: string };
      };

      if (!payload.ok || !payload.members) {
        break;
      }

      for (const member of payload.members) {
        if (member.deleted || member.is_bot) continue;

        const userId = member.id;

        // Index by all name forms so matching is flexible
        if (member.name) {
          map.set(normalizeName(member.name), userId);
        }
        if (member.profile?.display_name) {
          map.set(normalizeName(member.profile.display_name), userId);
        }
        if (member.profile?.real_name) {
          map.set(normalizeName(member.profile.real_name), userId);
        }
      }

      cursor = payload.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logWarn(
      "slack_users_list_failed",
      {},
      {
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to fetch Slack users.list for name→ID resolution",
    );
  }

  return map;
}

let nameToUserIdInflight: Promise<Map<string, string>> | null = null;

async function getNameToUserIdMap(): Promise<Map<string, string>> {
  if (nameToUserIdCache && nameToUserIdCache.expiresAt > Date.now()) {
    return nameToUserIdCache.map;
  }
  // Deduplicate concurrent callers — only one fetch in flight at a time.
  if (nameToUserIdInflight) {
    return nameToUserIdInflight;
  }
  nameToUserIdInflight = buildNameToUserIdMap()
    .then((map) => {
      // Only cache if we got a non-empty result (empty likely means partial failure).
      if (map.size > 0) {
        nameToUserIdCache = {
          map,
          expiresAt: Date.now() + NAME_TO_USERID_CACHE_TTL_MS,
        };
      }
      nameToUserIdInflight = null;
      return map;
    })
    .catch((err) => {
      nameToUserIdInflight = null;
      throw err;
    });
  return nameToUserIdInflight;
}

/**
 * Resolve a Slack display name / username to a Slack user ID.
 * Returns null when the name cannot be resolved or the API is unavailable.
 * Results are backed by a workspace-scoped in-memory cache (10 min TTL).
 */
export async function lookupSlackUserIdByName(
  name: string,
): Promise<string | null> {
  const map = await getNameToUserIdMap();
  return map.get(normalizeName(name)) ?? null;
}
