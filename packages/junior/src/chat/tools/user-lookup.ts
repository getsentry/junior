import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as z from "zod";
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
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

const linkedSlackIdentity = alias(
  juniorIdentities,
  "user_lookup_slack_identity",
);

type LinkedIdentity = { provider: string; handle: string };
type UserLookupProfile =
  | SlackUserProfile
  | Pick<SlackUserProfile, "id" | "name">;
type UserLookupMatch = UserLookupProfile & {
  mention: string;
  matched_providers: string[];
  linked_identities?: LinkedIdentity[];
};

type UserLookupSearchMeta = {
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
};

type UserLookupResult = {
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

function isSlackUserNotFound(error: unknown): boolean {
  return (
    error instanceof SlackActionError &&
    (error.apiError === "user_not_found" || error.code === "not_found")
  );
}

function explicitUserLookupError(error: SlackActionError): string | undefined {
  if (isSlackUserNotFound(error)) {
    return "No Slack user found for the supplied user ID.";
  }
  if (error.code === "missing_scope") {
    return error.needed
      ? `User lookup is unavailable because this installation is missing the \`${error.needed}\` scope.`
      : "User lookup is unavailable because this installation is missing a required Slack scope.";
  }
  if (error.code === "invalid_arguments") {
    return `Slack rejected the user lookup arguments (${error.apiError ?? error.code}).`;
  }
  if (error.code === "feature_unavailable") {
    return "User lookup is not available for this workspace or app installation.";
  }
  return undefined;
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

function looksLikeEmail(query: string): boolean {
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
          handle: account.handle,
          display_name: account.displayName,
          url: account.url,
        })),
    ),
  };
}

/**
 * Merge each provider's matches into one candidate per person, in provider
 * order, with the providers that matched and the person's linked accounts.
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
  for (const { provider, users } of args.matches) {
    for (const user of users) {
      const existing = byUserId.get(user.id);
      if (existing) {
        if (!existing.matched_providers.includes(provider)) {
          existing.matched_providers.push(provider);
        }
        continue;
      }
      byUserId.set(user.id, {
        ...user,
        mention: slackMention(user.id),
        matched_providers: [provider],
      });
    }
  }
  const candidates = [...byUserId.values()].slice(0, MAX_LOOKUP_USERS);
  const linked = await linkedIdentitiesBySlackUser(
    args.teamId,
    candidates.map((user) => user.id),
    args.providers,
  );
  const users = candidates.map((user) => {
    const linkedIdentities = linked.get(user.id);
    return linkedIdentities
      ? { ...user, linked_identities: linkedIdentities }
      : user;
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
    const slack = await findSlackUsers(teamId, query);
    if (slack.users.length === 0 && looksLikeEmail(query)) {
      throw new ToolInputError(
        `No Slack user found with email address ${query}.`,
      );
    }
    return { matches: [slack], accounts: [] };
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

/** Static definition of `userLookup` for these identity providers. */
export function userLookupToolDefinition(providers: [string, ...string[]]) {
  return zodToolDefinition({
    description:
      "Look up people across identity providers, or in one. Name search can miss people in large workspaces. Each match has a Slack `mention` (`<@U…>`), the providers that matched (`matched_providers`), and the verified handles of accounts the person linked to you (`linked_identities`), such as `github`. `accounts` lists provider accounts that no known person linked. When `ambiguous` is true, ask which person the user means.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        provider: z
          .enum(providers)
          .optional()
          .describe(
            "Identity provider to search. Omit it to search every enabled provider.",
          ),
        query: z
          .string()
          .trim()
          .min(1)
          .describe(
            "ID, handle, email, `<@U…>` mention, or name. Pass the Slack user ID (`U…`) whenever the conversation shows one, such as an `author_id` or a mention. Search by name only with no known ID.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
  });
}

/** Create the tool that resolves people by identity provider and query. */
export function createUserLookupTool(
  teamId: SlackTeamId,
  providers: [string, ...string[]],
  egress: PluginEgress,
) {
  return zodTool({
    ...userLookupToolDefinition(providers),
    execute: async ({ provider, query }) => {
      try {
        return await lookupResult({
          teamId,
          providers,
          provider,
          query,
          ...(await findMatches(teamId, egress, providers, provider, query)),
        });
      } catch (error) {
        if (error instanceof SlackActionError) {
          const message = explicitUserLookupError(error);
          if (message) {
            throw new ToolInputError(message, { cause: error });
          }
        }
        throw error;
      }
    },
  });
}
