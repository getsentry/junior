import { getSlackClient, withSlackRetries } from "@/chat/slack/client";

/** Normalized Slack user profile returned by lookup helpers. */
export interface SlackUserProfile {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  title?: string;
  email?: string;
  status_text?: string;
  status_emoji?: string;
  is_bot: boolean;
  is_deleted: boolean;
  timezone?: string;
  profile_fields?: Array<{
    id: string;
    label?: string;
    value?: string;
    alt?: string;
  }>;
}

interface SlackProfileFieldRaw {
  value?: string;
  alt?: string;
  label?: string;
}

interface SlackUserRaw {
  id?: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
    email?: string;
    status_text?: string;
    status_emoji?: string;
    fields?: Record<string, SlackProfileFieldRaw> | null;
  };
}

/** Normalize a raw Slack user object into a clean profile. */
function normalizeUser(raw: SlackUserRaw): SlackUserProfile {
  const rawFields = raw.profile?.fields;
  const profileFields: SlackUserProfile["profile_fields"] = [];

  if (rawFields && typeof rawFields === "object") {
    for (const [id, field] of Object.entries(rawFields)) {
      if (!field) continue;
      profileFields.push({
        id,
        label: field.label || undefined,
        value: field.value || undefined,
        alt: field.alt || undefined,
      });
    }
  }

  return {
    id: raw.id ?? "",
    team_id: raw.team_id || undefined,
    name: raw.name || undefined,
    real_name: raw.real_name || raw.profile?.real_name || undefined,
    display_name: raw.profile?.display_name || undefined,
    title: raw.profile?.title || undefined,
    email: raw.profile?.email || undefined,
    status_text: raw.profile?.status_text || undefined,
    status_emoji: raw.profile?.status_emoji || undefined,
    is_bot: raw.is_bot ?? false,
    is_deleted: raw.deleted ?? false,
    timezone: raw.tz || undefined,
    ...(profileFields.length > 0 ? { profile_fields: profileFields } : {}),
  };
}

/** Look up a single Slack user by ID. Returns full profile including custom fields. */
export async function lookupSlackUserProfile(
  userId: string,
): Promise<SlackUserProfile> {
  const client = getSlackClient();
  const result = await withSlackRetries(
    () => client.users.info({ user: userId }),
    3,
    { action: "users.info" },
  );

  const user = result.user as SlackUserRaw | undefined;
  if (!user) {
    throw new Error(`Slack users.info returned no user for ${userId}`);
  }

  return normalizeUser(user);
}

/** Look up a Slack user by email address. Returns null if not found. */
export async function lookupSlackUserByEmail(
  email: string,
): Promise<SlackUserProfile | null> {
  const client = getSlackClient();

  let result;
  try {
    result = await withSlackRetries(
      () => client.users.lookupByEmail({ email }),
      3,
      { action: "users.lookupByEmail" },
    );
  } catch (error: unknown) {
    const apiError = (error as { apiError?: string }).apiError;
    if (apiError === "users_not_found") {
      return null;
    }
    throw error;
  }

  const user = result.user as SlackUserRaw | undefined;
  if (!user) {
    return null;
  }

  return normalizeUser(user);
}

/** Search result from a bounded workspace user scan. */
export interface SlackUserSearchResult {
  users: SlackUserProfile[];
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
}

/** Score how well a user matches a search query. Higher is better, 0 means no match. */
function scoreMatch(user: SlackUserRaw, queryLower: string): number {
  const name = (user.name ?? "").toLowerCase();
  const realName = (
    user.real_name ??
    user.profile?.real_name ??
    ""
  ).toLowerCase();
  const displayName = (user.profile?.display_name ?? "").toLowerCase();

  // Exact matches on key fields
  if (name === queryLower || displayName === queryLower) return 100;
  if (realName === queryLower) return 90;

  // Prefix matches
  if (name.startsWith(queryLower) || displayName.startsWith(queryLower))
    return 70;
  if (realName.startsWith(queryLower)) return 60;

  // Word-boundary matches in real name (e.g. "markus" matches "Markus Unterwaditzer")
  const realNameWords = realName.split(/\s+/);
  if (realNameWords.some((w) => w === queryLower)) return 55;
  if (realNameWords.some((w) => w.startsWith(queryLower))) return 50;

  // Substring matches
  if (name.includes(queryLower) || displayName.includes(queryLower)) return 30;
  if (realName.includes(queryLower)) return 20;

  return 0;
}

/**
 * Search workspace users by name. Paginates through `users.list` with
 * bounded page count, filters and ranks matches locally.
 */
export async function searchSlackUsers(options: {
  query: string;
  limit?: number;
  maxPages?: number;
  includeDeleted?: boolean;
  includeBots?: boolean;
}): Promise<SlackUserSearchResult> {
  const {
    query,
    limit = 10,
    maxPages = 3,
    includeDeleted = false,
    includeBots = false,
  } = options;
  const queryLower = query.toLowerCase().trim();

  const client = getSlackClient();
  const matches: Array<{ user: SlackUserRaw; score: number }> = [];
  let cursor: string | undefined;
  let pages = 0;
  let totalScanned = 0;
  let hasMore = false;

  while (pages < maxPages) {
    pages++;

    const result = await withSlackRetries(
      () =>
        client.users.list({
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      3,
      { action: "users.list" },
    );

    const members = (result.members ?? []) as SlackUserRaw[];
    totalScanned += members.length;

    for (const member of members) {
      if (!includeDeleted && member.deleted) continue;
      if (!includeBots && member.is_bot) continue;
      // Skip Slackbot
      if (member.id === "USLACKBOT") continue;

      const score = scoreMatch(member, queryLower);
      if (score > 0) {
        matches.push({ user: member, score });
      }
    }

    const nextCursor = result.response_metadata?.next_cursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  hasMore = Boolean(cursor);

  // Sort by score descending, then alphabetically by name
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.user.name ?? "").localeCompare(b.user.name ?? "");
  });

  const topMatches = matches.slice(0, limit);

  return {
    users: topMatches.map((m) => normalizeUser(m.user)),
    searched_pages: pages,
    searched_user_count: totalScanned,
    truncated: hasMore,
  };
}
