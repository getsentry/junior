import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import type { SlackUserId } from "@/chat/slack/ids";

/** Normalized Slack user profile with custom fields from the Slack workspace. */
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
  /** True for guests, multi-channel guests, and Slack Connect strangers. */
  is_external: boolean;
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
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
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

/** Minimal Slack user fields needed to score a name-search query. */
export type SlackNameSearchCandidate = {
  name?: string;
  real_name?: string;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
};

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
    status_text: raw.profile?.status_text ?? undefined,
    status_emoji: raw.profile?.status_emoji ?? undefined,
    is_bot: raw.is_bot ?? false,
    is_deleted: raw.deleted ?? false,
    is_external: isExternalSlackUser(raw),
    timezone: raw.tz || undefined,
    ...(profileFields.length > 0 ? { profile_fields: profileFields } : {}),
  };
}

/** Guests and Slack Connect strangers should lose ties to full workspace members. */
function isExternalSlackUser(user: SlackNameSearchCandidate): boolean {
  return Boolean(
    user.is_restricted || user.is_ultra_restricted || user.is_stranger,
  );
}

function normalizeNameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function nameFields(user: SlackNameSearchCandidate): string[] {
  return [
    user.name ?? "",
    user.profile?.display_name ?? "",
    user.real_name ?? user.profile?.real_name ?? "",
  ]
    .map((value) => value.toLowerCase().trim())
    .filter(Boolean);
}

/** Look up a Slack user by ID, returning the full profile including custom fields. */
export async function lookupSlackUserProfile(
  userId: SlackUserId,
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

/** Look up a Slack user by email. Returns null when no user matches. */
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

export interface SlackUserSearchResult {
  users: SlackUserProfile[];
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
}

/**
 * Rank Slack name-search quality for one candidate.
 * Exact field/token matches beat prefixes so a display-name prefix like
 * "Colin Curtin (Square)" does not outrank a real-name first-name hit.
 * External/guest accounts are demoted so full members win common first names.
 */
export function scoreSlackNameQuery(
  user: SlackNameSearchCandidate,
  query: string,
): number {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return 0;

  const fields = nameFields(user);
  if (fields.length === 0) return 0;

  let best = 0;
  const queryTokens = normalizeNameTokens(queryLower);

  for (const field of fields) {
    if (field === queryLower) {
      best = Math.max(best, 100);
      continue;
    }
    if (field.startsWith(queryLower)) {
      best = Math.max(best, 70);
    } else if (field.includes(queryLower)) {
      best = Math.max(best, 25);
    }

    const tokens = normalizeNameTokens(field);
    for (const token of tokens) {
      if (token === queryLower) {
        best = Math.max(best, 85);
      } else if (token.startsWith(queryLower)) {
        best = Math.max(best, 60);
      }
    }

    // Multi-token queries like "colin kawai" should beat single-token ties.
    if (
      queryTokens.length > 1 &&
      queryTokens.every((queryToken) =>
        tokens.some(
          (token) => token === queryToken || token.startsWith(queryToken),
        ),
      )
    ) {
      best = Math.max(best, 95);
    }
  }

  if (best <= 0) return 0;
  // Keep a positive score so external hits still surface when they are unique.
  if (isExternalSlackUser(user)) {
    best = Math.max(1, best - 40);
  }
  return best;
}

function compareNameMatches(
  left: { user: SlackUserRaw; score: number },
  right: { user: SlackUserRaw; score: number },
): number {
  if (right.score !== left.score) return right.score - left.score;

  const leftExternal = isExternalSlackUser(left.user) ? 1 : 0;
  const rightExternal = isExternalSlackUser(right.user) ? 1 : 0;
  if (leftExternal !== rightExternal) return leftExternal - rightExternal;

  // Prefer the shorter real/display name on ties so padded external labels lose.
  const leftLabel =
    left.user.real_name ??
    left.user.profile?.real_name ??
    left.user.profile?.display_name ??
    left.user.name ??
    "";
  const rightLabel =
    right.user.real_name ??
    right.user.profile?.real_name ??
    right.user.profile?.display_name ??
    right.user.name ??
    "";
  if (leftLabel.length !== rightLabel.length) {
    return leftLabel.length - rightLabel.length;
  }

  return (left.user.name ?? "").localeCompare(right.user.name ?? "");
}

async function listWorkspaceUsers(options: {
  maxPages: number;
  includeDeleted: boolean;
  includeBots: boolean;
  score: (member: SlackUserRaw) => number;
}): Promise<{
  matches: Array<{ user: SlackUserRaw; score: number }>;
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
}> {
  const client = getSlackClient();
  const matches: Array<{ user: SlackUserRaw; score: number }> = [];
  let cursor: string | undefined;
  let pages = 0;
  let totalScanned = 0;

  while (pages < options.maxPages) {
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
      if (!options.includeDeleted && member.deleted) continue;
      if (!options.includeBots && member.is_bot) continue;
      if (member.id === "USLACKBOT") continue;

      const score = options.score(member);
      if (score <= 0) continue;
      matches.push({ user: member, score });
    }

    const nextCursor = result.response_metadata?.next_cursor;
    if (!nextCursor) {
      cursor = undefined;
      break;
    }
    cursor = nextCursor;
  }

  return {
    matches,
    searched_pages: pages,
    searched_user_count: totalScanned,
    // True only when we hit the page cap with more data remaining.
    truncated: pages >= options.maxPages && Boolean(cursor),
  };
}

/** Search workspace users by name with bounded pagination through `users.list`. */
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
  const listed = await listWorkspaceUsers({
    maxPages,
    includeDeleted,
    includeBots,
    score: (member) => scoreSlackNameQuery(member, queryLower),
  });

  listed.matches.sort(compareNameMatches);

  return {
    users: listed.matches.slice(0, limit).map((m) => normalizeUser(m.user)),
    searched_pages: listed.searched_pages,
    searched_user_count: listed.searched_user_count,
    truncated: listed.truncated,
  };
}
