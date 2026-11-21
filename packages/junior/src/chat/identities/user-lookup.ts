import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PluginEgress } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { searchPluginUsers } from "@/chat/plugins/user-search-hooks";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { SlackActionError } from "@/chat/slack/client";
import { slackMention } from "@/chat/slack/mrkdwn";
import { parseSlackUserId, type SlackTeamId } from "@/chat/slack/ids";
import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { juniorIdentities } from "@/db/schema";

const linkedSlackIdentity = alias(
  juniorIdentities,
  "user_lookup_slack_identity",
);

type LinkedIdentity = { provider: string; handle: string };
type UserLookupProfile =
  | SlackUserProfile
  | Pick<SlackUserProfile, "id" | "name">;
/**
 * One person, as their Slack profile. `has_user` is true when Junior knows
 * them as a User, so their linked accounts are verified.
 */
type UserLookupMatch = UserLookupProfile & {
  provider: "slack";
  has_user: boolean;
  mention: string;
  matched_providers: string[];
  linked_identities?: LinkedIdentity[];
};

type UserLookupSearchMeta = {
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
};

/** Merged candidates of one person search, for any surface that shows them. */
export type UserLookupResult = {
  provider?: string;
  query: string;
  count: number;
  ambiguous: boolean;
  mention?: string;
  user?: UserLookupMatch | undefined;
  users?: UserLookupMatch[];
  accounts?: UnlinkedAccount[];
} & Partial<UserLookupSearchMeta>;

/** A provider account that matched, which no known person has linked. */
type UnlinkedAccount = {
  provider: string;
  has_user: false;
  id: string;
  handle?: string | undefined;
  display_name?: string | undefined;
  url?: string | undefined;
};

/** The people that one identity provider matched, as Slack profiles. */
type ProviderMatches = {
  provider: string;
  users: UserLookupProfile[];
  search?: UserLookupSearchMeta | undefined;
};

const MAX_LOOKUP_USERS = 10;

/** Return true when Slack says the user ID belongs to nobody. */
export function isSlackUserNotFound(error: unknown): boolean {
  return (
    error instanceof SlackActionError &&
    (error.apiError === "user_not_found" || error.code === "not_found")
  );
}

function slackProfileFromIdentity(
  identity: typeof juniorIdentities.$inferSelect,
): SlackUserProfile {
  return {
    id: identity.providerSubjectId,
    name: identity.handle ?? undefined,
    real_name: identity.displayName ?? undefined,
    display_name: identity.displayName ?? undefined,
    email: identity.email ?? undefined,
    is_bot: false,
    is_deleted: false,
  };
}

function slackMentionProfileFromIdentity(
  identity: typeof juniorIdentities.$inferSelect,
): UserLookupProfile {
  return {
    id: identity.providerSubjectId,
    name: identity.handle ?? undefined,
  };
}

async function storedSlackUserByEmail(
  teamId: SlackTeamId,
  email: string,
): Promise<SlackUserProfile | undefined> {
  const emailNormalized = normalizeIdentityEmail(email);
  if (!emailNormalized) return undefined;
  const identities = await getSqlExecutor()
    .db()
    .select()
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.emailVerified, true),
        eq(juniorIdentities.emailNormalized, emailNormalized),
      ),
    )
    .limit(2);
  if (identities.length > 1) {
    throw new Error(
      `Multiple Slack users share verified email ${emailNormalized} in workspace ${teamId}`,
    );
  }
  return identities[0] ? slackProfileFromIdentity(identities[0]) : undefined;
}

/**
 * Read the handles of other provider accounts that each Slack user linked to
 * Junior, so a reply or a GitHub write can mention them on that provider.
 * Only account-linking flows write these identities, so the handles are
 * provider-verified. A Slack profile field is not.
 */
async function linkedIdentitiesBySlackUser(
  teamId: SlackTeamId,
  slackUserIds: string[],
  providers: string[],
): Promise<Map<string, LinkedIdentity[]>> {
  const linked = new Map<string, LinkedIdentity[]>();
  const otherProviders = providers.filter((provider) => provider !== "slack");
  if (slackUserIds.length === 0 || otherProviders.length === 0) return linked;
  const rows = await getSqlExecutor()
    .db()
    .select({
      slackUserId: linkedSlackIdentity.providerSubjectId,
      provider: juniorIdentities.provider,
      handle: juniorIdentities.handle,
    })
    .from(linkedSlackIdentity)
    .innerJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.userId, linkedSlackIdentity.userId),
        eq(juniorIdentities.kind, "user"),
        inArray(juniorIdentities.provider, otherProviders),
        isNotNull(juniorIdentities.handle),
      ),
    )
    .where(
      and(
        eq(linkedSlackIdentity.kind, "user"),
        eq(linkedSlackIdentity.provider, "slack"),
        eq(linkedSlackIdentity.providerTenantId, teamId),
        inArray(linkedSlackIdentity.providerSubjectId, slackUserIds),
      ),
    )
    .orderBy(juniorIdentities.provider, juniorIdentities.handle);
  for (const row of rows) {
    if (!row.handle) continue;
    const entries = linked.get(row.slackUserId) ?? [];
    entries.push({ provider: row.provider, handle: row.handle });
    linked.set(row.slackUserId, entries);
  }
  return linked;
}

/** Return the Slack user IDs in a workspace that belong to a Junior User. */
async function slackUserIdsWithUser(
  teamId: SlackTeamId,
  slackUserIds: string[],
): Promise<Set<string>> {
  if (slackUserIds.length === 0) return new Set();
  const rows = await getSqlExecutor()
    .db()
    .select({ slackUserId: juniorIdentities.providerSubjectId })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerTenantId, teamId),
        inArray(juniorIdentities.providerSubjectId, slackUserIds),
        isNotNull(juniorIdentities.userId),
      ),
    );
  return new Set(rows.map((row) => row.slackUserId));
}

/** Return true when a query is an email address. */
export function looksLikeEmail(query: string): boolean {
  // Require local@domain so bare @handles stay name searches.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query);
}

/** Read a Slack user ID from a bare ID or a `<@U…>` mention. */
function slackUserIdFromQuery(query: string) {
  return (
    parseSlackUserId(query) ??
    parseSlackUserId(/^<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>$/.exec(query)?.[1])
  );
}

async function findSlackUsers(
  teamId: SlackTeamId,
  query: string,
): Promise<ProviderMatches> {
  const userId = slackUserIdFromQuery(query);
  if (userId) {
    return { provider: "slack", users: [await lookupSlackUserProfile(userId)] };
  }

  if (looksLikeEmail(query)) {
    const profile =
      (await storedSlackUserByEmail(teamId, query)) ??
      (await lookupSlackUserByEmail(query));
    return { provider: "slack", users: profile ? [profile] : [] };
  }

  const result = await searchSlackUsers({
    query,
    limit: MAX_LOOKUP_USERS,
    maxPages: 3,
    includeBots: false,
  });
  return {
    provider: "slack",
    users: result.users,
    search: {
      searched_pages: result.searched_pages,
      searched_user_count: result.searched_user_count,
      truncated: result.truncated,
    },
  };
}

/**
 * Find people by the identities that account-linking flows stored for other
 * providers, matching a subject ID, a handle, or a verified email.
 */
async function findStoredUsers(
  teamId: SlackTeamId,
  providers: string[],
  query: string,
): Promise<ProviderMatches[]> {
  if (providers.length === 0) return [];
  const emailNormalized = looksLikeEmail(query)
    ? normalizeIdentityEmail(query)
    : undefined;
  const rows = await getSqlExecutor()
    .db()
    .select({ provider: juniorIdentities.provider, slack: linkedSlackIdentity })
    .from(juniorIdentities)
    .innerJoin(
      linkedSlackIdentity,
      and(
        eq(linkedSlackIdentity.userId, juniorIdentities.userId),
        eq(linkedSlackIdentity.kind, "user"),
        eq(linkedSlackIdentity.provider, "slack"),
        eq(linkedSlackIdentity.providerTenantId, teamId),
      ),
    )
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        inArray(juniorIdentities.provider, providers),
        or(
          eq(juniorIdentities.providerSubjectId, query),
          sql`lower(${juniorIdentities.handle}) = lower(${query})`,
          emailNormalized
            ? and(
                eq(juniorIdentities.emailVerified, true),
                eq(juniorIdentities.emailNormalized, emailNormalized),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(juniorIdentities.provider)
    .limit(MAX_LOOKUP_USERS * providers.length);
  return providers.map((provider) => ({
    provider,
    users: rows
      .filter((row) => row.provider === provider)
      .slice(0, MAX_LOOKUP_USERS)
      .map((row) => slackMentionProfileFromIdentity(row.slack)),
  }));
}

/**
 * Ask provider plugins for accounts that match, then link each account to
 * the Slack user of the person who connected it. Return accounts that no
 * known person connected on their own.
 */
async function findPluginUsers(
  teamId: SlackTeamId,
  egress: PluginEgress,
  providers: string[],
  query: string,
): Promise<{ matches: ProviderMatches[]; accounts: UnlinkedAccount[] }> {
  const results = (
    await searchPluginUsers({ egress, providers, query })
  ).filter((result) => result.accounts.length > 0);
  if (results.length === 0) return { matches: [], accounts: [] };
  const rows = await getSqlExecutor()
    .db()
    .select({
      provider: juniorIdentities.provider,
      subjectId: juniorIdentities.providerSubjectId,
      slack: linkedSlackIdentity,
    })
    .from(juniorIdentities)
    .innerJoin(
      linkedSlackIdentity,
      and(
        eq(linkedSlackIdentity.userId, juniorIdentities.userId),
        eq(linkedSlackIdentity.kind, "user"),
        eq(linkedSlackIdentity.provider, "slack"),
        eq(linkedSlackIdentity.providerTenantId, teamId),
      ),
    )
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        or(
          ...results.map((result) =>
            and(
              eq(juniorIdentities.provider, result.provider),
              inArray(
                juniorIdentities.providerSubjectId,
                result.accounts.map((account) => account.id),
              ),
            ),
          ),
        ),
      ),
    );
  const slackBySubject = new Map(
    rows.map((row) => [`${row.provider}:${row.subjectId}`, row.slack]),
  );
  return {
    matches: results.map((result) => ({
      provider: result.provider,
      users: result.accounts.flatMap((account) => {
        const slack = slackBySubject.get(`${result.provider}:${account.id}`);
        return slack ? [slackMentionProfileFromIdentity(slack)] : [];
      }),
    })),
    accounts: results.flatMap((result) =>
      result.accounts
        .filter(
          (account) => !slackBySubject.has(`${result.provider}:${account.id}`),
        )
        .map((account) => ({
          provider: result.provider,
          has_user: false as const,
          id: account.id,
          handle: account.handle,
          display_name: account.displayName,
          url: account.url,
        })),
    ),
  };
}

/**
 * Merge each provider's matches into one candidate per person, with the
 * providers that matched and the person's linked accounts. Exact matches
 * come before Slack name hits, so the cap never drops them.
 */
async function lookupResult(args: {
  teamId: SlackTeamId;
  providers: string[];
  provider?: string | undefined;
  query: string;
  matches: ProviderMatches[];
  accounts: UnlinkedAccount[];
}): Promise<UserLookupResult> {
  const byUserId = new Map<string, UserLookupMatch>();
  const exactUserIds = new Set<string>();
  for (const { provider, search, users } of args.matches) {
    for (const user of users) {
      // Only the Slack name search is fuzzy. An ID, handle, or email match
      // must not lose its place to name hits.
      if (!search) exactUserIds.add(user.id);
      const existing = byUserId.get(user.id);
      if (existing) {
        if (!existing.matched_providers.includes(provider)) {
          existing.matched_providers.push(provider);
        }
        continue;
      }
      byUserId.set(user.id, {
        ...user,
        provider: "slack",
        has_user: false,
        mention: slackMention(user.id),
        matched_providers: [provider],
      });
    }
  }
  const candidates = [...byUserId.values()]
    .sort(
      (left, right) =>
        Number(exactUserIds.has(right.id)) - Number(exactUserIds.has(left.id)),
    )
    .slice(0, MAX_LOOKUP_USERS);
  const candidateIds = candidates.map((user) => user.id);
  const [linked, withUser] = await Promise.all([
    linkedIdentitiesBySlackUser(args.teamId, candidateIds, args.providers),
    slackUserIdsWithUser(args.teamId, candidateIds),
  ]);
  const users = candidates.map((user) => {
    const match: UserLookupMatch = { ...user, has_user: withUser.has(user.id) };
    const linkedIdentities = linked.get(user.id);
    if (linkedIdentities) match.linked_identities = linkedIdentities;
    return match;
  });
  const search = args.matches.find((match) => match.search)?.search;
  return {
    ...(args.provider ? { provider: args.provider } : undefined),
    query: args.query,
    count: users.length,
    ambiguous: users.length + args.accounts.length > 1,
    ...(users.length === 1
      ? { mention: users[0]!.mention, user: users[0] }
      : { users }),
    ...(args.accounts.length > 0 ? { accounts: args.accounts } : undefined),
    ...search,
  };
}

/** Run the search of one provider, or of every enabled provider. */
async function findMatches(
  teamId: SlackTeamId,
  egress: PluginEgress,
  providers: string[],
  provider: string | undefined,
  query: string,
): Promise<{ matches: ProviderMatches[]; accounts: UnlinkedAccount[] }> {
  if (provider === "slack") {
    return { matches: [await findSlackUsers(teamId, query)], accounts: [] };
  }
  const otherProviders = provider
    ? [provider]
    : providers.filter((name) => name !== "slack");
  const [slack, stored, plugin] = await Promise.all([
    !provider && providers.includes("slack")
      ? findSlackUsers(teamId, query).catch((error: unknown) => {
          // An ID that is not a Slack user can still match another provider.
          if (isSlackUserNotFound(error)) {
            return { provider: "slack", users: [] };
          }
          throw error;
        })
      : undefined,
    findStoredUsers(teamId, otherProviders, query),
    findPluginUsers(teamId, egress, otherProviders, query),
  ]);
  return {
    matches: [...(slack ? [slack] : []), ...stored, ...plugin.matches],
    accounts: plugin.accounts,
  };
}

/**
 * Find people by an ID, handle, email, mention, or name: in one identity
 * provider, or in Slack, stored accounts, and plugin searches at once. The
 * `userLookup` tool and later API and MCP surfaces share this result.
 */
export async function lookupUsers(input: {
  egress: PluginEgress;
  provider?: string | undefined;
  providers: [string, ...string[]];
  query: string;
  teamId: SlackTeamId;
}): Promise<UserLookupResult> {
  const { egress, provider, providers, query, teamId } = input;
  return await lookupResult({
    teamId,
    providers,
    provider,
    query,
    ...(await findMatches(teamId, egress, providers, provider, query)),
  });
}
