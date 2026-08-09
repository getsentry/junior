import { and, eq, ilike, or, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  parseSlackUserId,
  type SlackTeamId,
  type SlackUserId,
} from "@/chat/slack/ids";
import {
  lookupSlackUserByEmail,
  lookupSlackUserProfile,
  searchSlackUsers,
  type SlackUserProfile,
} from "@/chat/slack/users";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";

export type SlackUserResolveMode = "user_id" | "email" | "query";

export interface ResolvedSlackUser {
  mention: string;
  slackUserId: SlackUserId;
  identityId: string;
  userId?: string;
  displayName?: string;
  handle?: string;
  email?: string;
  profile?: SlackUserProfile;
}

export interface SlackUserCandidate {
  slackUserId: string;
  displayName?: string;
  handle?: string;
}

export type SlackUserResolveResult =
  | { status: "resolved"; user: ResolvedSlackUser }
  | { status: "ambiguous"; candidates: SlackUserCandidate[] }
  | { status: "not_found" };

interface StoredSlackUser {
  identityId: string;
  slackUserId: string;
  userId?: string;
  displayName?: string;
  handle?: string;
  email?: string;
}

const storedSlackUserColumns = {
  identityId: juniorIdentities.id,
  slackUserId: juniorIdentities.providerSubjectId,
  userId: juniorIdentities.userId,
  displayName: sql<
    string | null
  >`coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName})`,
  handle: juniorIdentities.handle,
  email: juniorIdentities.email,
};

function storedSlackUser(row: {
  identityId: string;
  slackUserId: string;
  userId: string | null;
  displayName: string | null;
  handle: string | null;
  email: string | null;
}): StoredSlackUser {
  return {
    identityId: row.identityId,
    slackUserId: row.slackUserId,
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.email ? { email: row.email } : {}),
  };
}

function candidateFromStored(user: StoredSlackUser): SlackUserCandidate {
  return {
    slackUserId: user.slackUserId,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.handle ? { handle: user.handle } : {}),
  };
}

function candidateFromProfile(profile: SlackUserProfile): SlackUserCandidate {
  return {
    slackUserId: profile.id,
    ...(profile.real_name || profile.display_name
      ? { displayName: profile.real_name || profile.display_name }
      : {}),
    ...(profile.name ? { handle: profile.name } : {}),
  };
}

function resolvedFromStored(
  user: StoredSlackUser,
): ResolvedSlackUser | undefined {
  const slackUserId = parseSlackUserId(user.slackUserId);
  if (!slackUserId) return undefined;
  return {
    mention: `<@${slackUserId}>`,
    slackUserId,
    identityId: user.identityId,
    ...(user.userId ? { userId: user.userId } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.handle ? { handle: user.handle } : {}),
    ...(user.email ? { email: user.email } : {}),
  };
}

async function findStoredByUserId(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  slackUserId: SlackUserId,
): Promise<StoredSlackUser | undefined> {
  const rows = await db
    .select(storedSlackUserColumns)
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.providerSubjectId, slackUserId),
      ),
    )
    .limit(1);
  return rows[0] ? storedSlackUser(rows[0]) : undefined;
}

async function findStoredByEmail(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  email: string,
): Promise<StoredSlackUser[]> {
  const normalized = normalizeIdentityEmail(email);
  if (!normalized) return [];
  const rows = await db
    .select(storedSlackUserColumns)
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.kind, "user"),
        or(
          and(
            eq(juniorIdentities.emailVerified, true),
            eq(juniorIdentities.emailNormalized, normalized),
          ),
          eq(juniorUsers.primaryEmailNormalized, normalized),
        ),
      ),
    )
    .limit(10);
  return rows.map(storedSlackUser);
}

async function findStoredByExactName(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  query: string,
): Promise<StoredSlackUser[]> {
  const value = query.trim();
  if (!value) return [];
  const rows = await db
    .select(storedSlackUserColumns)
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.kind, "user"),
        or(
          ilike(juniorIdentities.handle, value),
          ilike(juniorIdentities.displayName, value),
          ilike(juniorUsers.displayName, value),
        ),
      ),
    )
    .limit(10);
  return rows.map(storedSlackUser);
}

async function persistProfile(
  sql: JuniorSqlDatabase,
  teamId: SlackTeamId,
  profile: SlackUserProfile,
): Promise<ResolvedSlackUser | undefined> {
  const slackUserId = parseSlackUserId(profile.id);
  if (!slackUserId || profile.is_deleted || profile.is_bot) return undefined;
  const displayName =
    profile.real_name || profile.display_name || profile.name || undefined;
  const identity = await upsertIdentity(sql, {
    kind: "user",
    provider: "slack",
    providerTenantId: teamId,
    providerSubjectId: slackUserId,
    ...(displayName ? { displayName } : {}),
    ...(profile.name ? { handle: profile.name } : {}),
    ...(profile.email ? { email: profile.email, emailVerified: true } : {}),
    metadata: { isBot: false, isDeleted: false },
  });
  return {
    mention: `<@${slackUserId}>`,
    slackUserId,
    identityId: identity.id,
    ...(identity.userId ? { userId: identity.userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(profile.name ? { handle: profile.name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    profile,
  };
}

function resultFromStored(users: StoredSlackUser[]): SlackUserResolveResult {
  const resolved = users
    .map(resolvedFromStored)
    .filter((user): user is ResolvedSlackUser => Boolean(user));
  if (resolved.length === 1) return { status: "resolved", user: resolved[0]! };
  if (resolved.length > 1) {
    return {
      status: "ambiguous",
      candidates: users.map(candidateFromStored),
    };
  }
  return { status: "not_found" };
}

/** Resolve one Slack user in the active workspace without guessing. */
export async function resolveSlackUser(args: {
  teamId: SlackTeamId;
  mode: SlackUserResolveMode;
  value: string;
  db?: JuniorDatabase;
  sql?: JuniorSqlDatabase;
}): Promise<SlackUserResolveResult> {
  const sql = args.sql ?? getSqlExecutor();
  const db = args.db ?? sql.db();
  const value = args.value.trim();
  if (!value) return { status: "not_found" };

  if (args.mode === "user_id") {
    const slackUserId = parseSlackUserId(value);
    if (!slackUserId) return { status: "not_found" };
    const stored = await findStoredByUserId(db, args.teamId, slackUserId);
    if (stored) return resultFromStored([stored]);
    const profile = await lookupSlackUserProfile(slackUserId);
    const resolved = await persistProfile(sql, args.teamId, profile);
    return resolved
      ? { status: "resolved", user: resolved }
      : { status: "not_found" };
  }

  if (args.mode === "email") {
    const stored = await findStoredByEmail(db, args.teamId, value);
    if (stored.length > 0) return resultFromStored(stored);
    const profile = await lookupSlackUserByEmail(value);
    if (!profile) return { status: "not_found" };
    const resolved = await persistProfile(sql, args.teamId, profile);
    return resolved
      ? { status: "resolved", user: resolved }
      : { status: "not_found" };
  }

  const stored = await findStoredByExactName(db, args.teamId, value);
  if (stored.length > 0) return resultFromStored(stored);

  const search = await searchSlackUsers({
    query: value,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  const candidates = search.users.filter(
    (profile) => !profile.is_deleted && !profile.is_bot,
  );
  const query = value.toLowerCase();
  const exact = candidates.filter(
    (profile) =>
      profile.name?.toLowerCase() === query ||
      profile.display_name?.toLowerCase() === query ||
      profile.real_name?.toLowerCase() === query,
  );
  const matches = exact.length > 0 ? exact : candidates;
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches.map(candidateFromProfile),
    };
  }
  const resolved = await persistProfile(sql, args.teamId, matches[0]!);
  return resolved
    ? { status: "resolved", user: resolved }
    : { status: "not_found" };
}
