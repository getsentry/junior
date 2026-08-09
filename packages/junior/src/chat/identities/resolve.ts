import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
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
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";

export type PersonResolveMode = "slack_user_id" | "email" | "query" | "github";

export interface ResolvedPersonMatch {
  /** Slack mrkdwn mention token for delivery (`<@U…>`). */
  mention: string;
  match: "exact" | "unique";
  mode: PersonResolveMode;
  slack_user_id: SlackUserId;
  team_id: SlackTeamId;
  user_id?: string;
  identity_id?: string;
  display_name?: string;
  handle?: string;
  /** Present only when the caller already supplied an email lookup. */
  email?: string;
  is_bot?: boolean;
  is_deleted?: boolean;
  github_username?: string;
  /** Live Slack profile when one was loaded during resolve. */
  profile?: SlackUserProfile;
}

export interface PersonResolveCandidate {
  slack_user_id: string;
  display_name?: string;
  handle?: string;
  is_bot?: boolean;
  is_deleted?: boolean;
  github_username?: string;
}

export type PersonResolveResult =
  | { status: "resolved"; person: ResolvedPersonMatch }
  | {
      status: "ambiguous";
      mode: PersonResolveMode;
      query: string;
      candidates: PersonResolveCandidate[];
    }
  | { status: "not_found"; mode: PersonResolveMode; query: string };

interface StoredSlackPerson {
  identityId: string;
  userId?: string;
  slackUserId: string;
  teamId: string;
  displayName?: string;
  handle?: string;
  email?: string;
}

function formatSlackMention(userId: SlackUserId): string {
  return `<@${userId}>`;
}

function githubUsernameFromProfile(
  profile: SlackUserProfile,
): string | undefined {
  for (const field of profile.profile_fields ?? []) {
    const label = field.label?.toLowerCase() ?? "";
    const value = field.value?.trim() || field.alt?.trim() || "";
    if (!value) continue;
    const looksLikeGithub =
      label.includes("github") ||
      /github\.com\//i.test(value) ||
      field.id.toLowerCase().includes("github");
    if (!looksLikeGithub) continue;
    const fromUrl = value.match(/github\.com\/([A-Za-z0-9-]+)/i)?.[1];
    const username = (fromUrl ?? value.replace(/^@/, "")).trim();
    if (username) return username;
  }
  return undefined;
}

function candidateFromProfile(
  profile: SlackUserProfile,
): PersonResolveCandidate {
  return {
    slack_user_id: profile.id,
    ...(profile.real_name || profile.display_name
      ? { display_name: profile.real_name || profile.display_name }
      : {}),
    ...(profile.name ? { handle: profile.name } : {}),
    is_bot: profile.is_bot,
    is_deleted: profile.is_deleted,
    ...(githubUsernameFromProfile(profile)
      ? { github_username: githubUsernameFromProfile(profile) }
      : {}),
  };
}

async function persistSlackProfile(
  sqlDb: JuniorSqlDatabase,
  teamId: SlackTeamId,
  profile: SlackUserProfile,
): Promise<StoredSlackPerson | undefined> {
  if (!profile.id || profile.is_deleted) {
    return undefined;
  }
  const displayName =
    profile.real_name || profile.display_name || profile.name || undefined;
  const stored = await upsertIdentity(sqlDb, {
    kind: profile.is_bot ? "service" : "user",
    provider: "slack",
    providerTenantId: teamId,
    providerSubjectId: profile.id,
    ...(displayName ? { displayName } : {}),
    ...(profile.name ? { handle: profile.name } : {}),
    ...(profile.email ? { email: profile.email, emailVerified: true } : {}),
    metadata: {
      platform: "slack",
      isBot: profile.is_bot,
      isDeleted: profile.is_deleted,
    },
  });

  const githubUsername = githubUsernameFromProfile(profile);
  if (githubUsername && stored.userId) {
    await upsertIdentity(sqlDb, {
      kind: "user",
      provider: "github",
      providerSubjectId: githubUsername.toLowerCase(),
      handle: githubUsername,
      displayName: githubUsername,
      ...(profile.email ? { email: profile.email, emailVerified: true } : {}),
      metadata: { platform: "github", source: "slack_profile" },
    });
  }

  return {
    identityId: stored.id,
    ...(stored.userId ? { userId: stored.userId } : {}),
    slackUserId: profile.id,
    teamId,
    ...(displayName ? { displayName } : {}),
    ...(profile.name ? { handle: profile.name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
  };
}

async function loadStoredSlackPerson(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  slackUserId: string,
): Promise<StoredSlackPerson | undefined> {
  const rows = await db
    .select({
      identityId: juniorIdentities.id,
      userId: juniorIdentities.userId,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
      displayName: sql<
        string | null
      >`coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName})`,
      handle: juniorIdentities.handle,
      email: juniorIdentities.email,
    })
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
  const row = rows[0];
  if (!row) return undefined;
  return {
    identityId: row.identityId,
    ...(row.userId ? { userId: row.userId } : {}),
    slackUserId: row.slackUserId,
    teamId: row.teamId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.email ? { email: row.email } : {}),
  };
}

async function findStoredByEmail(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  email: string,
): Promise<StoredSlackPerson[]> {
  const emailNormalized = normalizeIdentityEmail(email);
  if (!emailNormalized) return [];
  const rows = await db
    .select({
      identityId: juniorIdentities.id,
      userId: juniorIdentities.userId,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
      displayName: sql<
        string | null
      >`coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName})`,
      handle: juniorIdentities.handle,
      email: juniorIdentities.email,
    })
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
            eq(juniorIdentities.emailNormalized, emailNormalized),
          ),
          eq(juniorUsers.primaryEmailNormalized, emailNormalized),
        ),
      ),
    )
    .limit(5);
  return rows.map((row) => ({
    identityId: row.identityId,
    ...(row.userId ? { userId: row.userId } : {}),
    slackUserId: row.slackUserId,
    teamId: row.teamId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.email ? { email: row.email } : {}),
  }));
}

async function findStoredByQuery(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  query: string,
): Promise<StoredSlackPerson[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const rows = await db
    .select({
      identityId: juniorIdentities.id,
      userId: juniorIdentities.userId,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
      displayName: sql<
        string | null
      >`coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName})`,
      handle: juniorIdentities.handle,
      email: juniorIdentities.email,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.kind, "user"),
        or(
          ilike(juniorIdentities.handle, normalized),
          ilike(juniorIdentities.displayName, normalized),
          ilike(juniorUsers.displayName, normalized),
        ),
      ),
    )
    .limit(10);
  return rows.map((row) => ({
    identityId: row.identityId,
    ...(row.userId ? { userId: row.userId } : {}),
    slackUserId: row.slackUserId,
    teamId: row.teamId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.email ? { email: row.email } : {}),
  }));
}

async function findStoredByGithub(
  db: JuniorDatabase,
  teamId: SlackTeamId,
  githubUsername: string,
): Promise<StoredSlackPerson[]> {
  const handle = githubUsername.trim().replace(/^@/, "");
  if (!handle) return [];
  const githubRows = await db
    .select({
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "github"),
        eq(juniorIdentities.kind, "user"),
        or(
          ilike(juniorIdentities.handle, handle),
          eq(juniorIdentities.providerSubjectId, handle.toLowerCase()),
        ),
      ),
    )
    .limit(5);
  const userIds = [
    ...new Set(
      githubRows
        .map((row) => row.userId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (userIds.length === 0) return [];

  const rows = await db
    .select({
      identityId: juniorIdentities.id,
      userId: juniorIdentities.userId,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
      displayName: sql<
        string | null
      >`coalesce(${juniorUsers.displayName}, ${juniorIdentities.displayName})`,
      handle: juniorIdentities.handle,
      email: juniorIdentities.email,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.kind, "user"),
        inArray(juniorIdentities.userId, userIds),
      ),
    )
    .limit(10);
  return rows.map((row) => ({
    identityId: row.identityId,
    ...(row.userId ? { userId: row.userId } : {}),
    slackUserId: row.slackUserId,
    teamId: row.teamId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.email ? { email: row.email } : {}),
  }));
}

function resolvedFromStored(args: {
  mode: PersonResolveMode;
  match: "exact" | "unique";
  teamId: SlackTeamId;
  stored: StoredSlackPerson;
  profile?: SlackUserProfile;
  includeEmail?: boolean;
}): ResolvedPersonMatch | undefined {
  const slackUserId = parseSlackUserId(args.stored.slackUserId);
  if (!slackUserId) return undefined;
  const displayName =
    args.stored.displayName ||
    args.profile?.real_name ||
    args.profile?.display_name ||
    undefined;
  const handle = args.stored.handle || args.profile?.name || undefined;
  const githubUsername = args.profile
    ? githubUsernameFromProfile(args.profile)
    : undefined;
  return {
    mention: formatSlackMention(slackUserId),
    match: args.match,
    mode: args.mode,
    slack_user_id: slackUserId,
    team_id: args.teamId,
    ...(args.stored.userId ? { user_id: args.stored.userId } : {}),
    identity_id: args.stored.identityId,
    ...(displayName ? { display_name: displayName } : {}),
    ...(handle ? { handle } : {}),
    ...(args.includeEmail && args.stored.email
      ? { email: args.stored.email }
      : {}),
    ...(args.profile
      ? { is_bot: args.profile.is_bot, is_deleted: args.profile.is_deleted }
      : {}),
    ...(githubUsername ? { github_username: githubUsername } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
  };
}

async function resolveFromProfile(args: {
  db: JuniorDatabase;
  sqlDb: JuniorSqlDatabase;
  teamId: SlackTeamId;
  mode: PersonResolveMode;
  match: "exact" | "unique";
  profile: SlackUserProfile;
  includeEmail?: boolean;
}): Promise<ResolvedPersonMatch | undefined> {
  if (!args.profile.id || args.profile.is_deleted) {
    return undefined;
  }
  const stored =
    (await persistSlackProfile(args.sqlDb, args.teamId, args.profile)) ??
    (await loadStoredSlackPerson(args.db, args.teamId, args.profile.id));
  if (!stored) {
    const slackUserId = parseSlackUserId(args.profile.id);
    if (!slackUserId) return undefined;
    return {
      mention: formatSlackMention(slackUserId),
      match: args.match,
      mode: args.mode,
      slack_user_id: slackUserId,
      team_id: args.teamId,
      ...(args.profile.real_name || args.profile.display_name
        ? {
            display_name:
              args.profile.real_name || args.profile.display_name || undefined,
          }
        : {}),
      ...(args.profile.name ? { handle: args.profile.name } : {}),
      ...(args.includeEmail && args.profile.email
        ? { email: args.profile.email }
        : {}),
      is_bot: args.profile.is_bot,
      is_deleted: args.profile.is_deleted,
      ...(githubUsernameFromProfile(args.profile)
        ? { github_username: githubUsernameFromProfile(args.profile) }
        : {}),
      profile: args.profile,
    };
  }
  return resolvedFromStored({
    mode: args.mode,
    match: args.match,
    teamId: args.teamId,
    stored,
    profile: args.profile,
    includeEmail: args.includeEmail,
  });
}

/** Resolve one person reference to a workspace Slack mention. */
export async function resolvePersonForSlackMention(args: {
  teamId: SlackTeamId;
  mode: PersonResolveMode;
  value: string;
  db?: JuniorDatabase;
  sqlDb?: JuniorSqlDatabase;
}): Promise<PersonResolveResult> {
  const sqlDb = args.sqlDb ?? getSqlExecutor();
  const db = args.db ?? sqlDb.db();
  const value = args.value.trim();
  if (!value) {
    return { status: "not_found", mode: args.mode, query: args.value };
  }

  if (args.mode === "slack_user_id") {
    const slackUserId = parseSlackUserId(value);
    if (!slackUserId) {
      return { status: "not_found", mode: args.mode, query: value };
    }
    const stored = await loadStoredSlackPerson(db, args.teamId, slackUserId);
    try {
      const profile = await lookupSlackUserProfile(slackUserId);
      const resolved = await resolveFromProfile({
        db,
        sqlDb,
        teamId: args.teamId,
        mode: args.mode,
        match: "exact",
        profile,
      });
      if (resolved) return { status: "resolved", person: resolved };
    } catch {
      if (stored) {
        const resolved = resolvedFromStored({
          mode: args.mode,
          match: "exact",
          teamId: args.teamId,
          stored,
        });
        if (resolved) return { status: "resolved", person: resolved };
      }
      return { status: "not_found", mode: args.mode, query: value };
    }
    return { status: "not_found", mode: args.mode, query: value };
  }

  if (args.mode === "email") {
    const stored = await findStoredByEmail(db, args.teamId, value);
    if (stored.length === 1) {
      const resolved = resolvedFromStored({
        mode: args.mode,
        match: "exact",
        teamId: args.teamId,
        stored: stored[0]!,
        includeEmail: true,
      });
      if (resolved) return { status: "resolved", person: resolved };
    }
    if (stored.length > 1) {
      return {
        status: "ambiguous",
        mode: args.mode,
        query: value,
        candidates: stored.map((row) => ({
          slack_user_id: row.slackUserId,
          ...(row.displayName ? { display_name: row.displayName } : {}),
          ...(row.handle ? { handle: row.handle } : {}),
        })),
      };
    }

    const profile = await lookupSlackUserByEmail(value);
    if (!profile) {
      return { status: "not_found", mode: args.mode, query: value };
    }
    const resolved = await resolveFromProfile({
      db,
      sqlDb,
      teamId: args.teamId,
      mode: args.mode,
      match: "exact",
      profile,
      includeEmail: true,
    });
    if (!resolved) {
      return { status: "not_found", mode: args.mode, query: value };
    }
    return { status: "resolved", person: resolved };
  }

  if (args.mode === "github") {
    const stored = await findStoredByGithub(db, args.teamId, value);
    if (stored.length === 1) {
      const resolved = resolvedFromStored({
        mode: args.mode,
        match: "exact",
        teamId: args.teamId,
        stored: stored[0]!,
      });
      if (resolved) {
        return {
          status: "resolved",
          person: {
            ...resolved,
            github_username: value.replace(/^@/, ""),
          },
        };
      }
    }
    if (stored.length > 1) {
      return {
        status: "ambiguous",
        mode: args.mode,
        query: value,
        candidates: stored.map((row) => ({
          slack_user_id: row.slackUserId,
          ...(row.displayName ? { display_name: row.displayName } : {}),
          ...(row.handle ? { handle: row.handle } : {}),
          github_username: value.replace(/^@/, ""),
        })),
      };
    }

    // Fall back to Slack name search, then match GitHub profile fields.
    const search = await searchSlackUsers({
      query: value.replace(/^@/, ""),
      limit: 10,
      maxPages: 3,
      includeBots: false,
    });
    const matches = search.users.filter((user) => {
      const github = githubUsernameFromProfile(user);
      return (
        github?.toLowerCase() === value.replace(/^@/, "").toLowerCase() &&
        !user.is_deleted
      );
    });
    if (matches.length === 1) {
      const resolved = await resolveFromProfile({
        db,
        sqlDb,
        teamId: args.teamId,
        mode: args.mode,
        match: "unique",
        profile: matches[0]!,
      });
      if (resolved) return { status: "resolved", person: resolved };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        mode: args.mode,
        query: value,
        candidates: matches.map(candidateFromProfile),
      };
    }
    return { status: "not_found", mode: args.mode, query: value };
  }

  // query mode: prefer exact stored handle/name, else live Slack search.
  const stored = await findStoredByQuery(db, args.teamId, value);
  const exactStored = stored.filter(
    (row) =>
      row.handle?.toLowerCase() === value.toLowerCase() ||
      row.displayName?.toLowerCase() === value.toLowerCase(),
  );
  if (exactStored.length === 1) {
    const resolved = resolvedFromStored({
      mode: args.mode,
      match: "exact",
      teamId: args.teamId,
      stored: exactStored[0]!,
    });
    if (resolved) return { status: "resolved", person: resolved };
  }
  if (exactStored.length > 1) {
    return {
      status: "ambiguous",
      mode: args.mode,
      query: value,
      candidates: exactStored.map((row) => ({
        slack_user_id: row.slackUserId,
        ...(row.displayName ? { display_name: row.displayName } : {}),
        ...(row.handle ? { handle: row.handle } : {}),
      })),
    };
  }

  const search = await searchSlackUsers({
    query: value,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  const active = search.users.filter((user) => !user.is_deleted);
  const exactLive = active.filter((user) => {
    const name = user.name?.toLowerCase() ?? "";
    const display = user.display_name?.toLowerCase() ?? "";
    const real = user.real_name?.toLowerCase() ?? "";
    const q = value.toLowerCase();
    return name === q || display === q || real === q;
  });
  const unique = exactLive.length === 1 ? exactLive : active;
  if (unique.length === 1) {
    const resolved = await resolveFromProfile({
      db,
      sqlDb,
      teamId: args.teamId,
      mode: args.mode,
      match: exactLive.length === 1 ? "exact" : "unique",
      profile: unique[0]!,
    });
    if (resolved) return { status: "resolved", person: resolved };
  }
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      mode: args.mode,
      query: value,
      candidates: unique.slice(0, 10).map(candidateFromProfile),
    };
  }
  return { status: "not_found", mode: args.mode, query: value };
}
