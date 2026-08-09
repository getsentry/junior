import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { upsertIdentity } from "@/chat/identities/sql";
import { SlackActionError } from "@/chat/slack/client";
import { parseSlackUserId, type SlackTeamId } from "@/chat/slack/ids";
import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  normalizeGithubUsername,
  searchSlackUsers,
  searchSlackUsersByGithubUsername,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { juniorIdentities } from "@/db/schema";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const USER_LOOKUP_PROVIDERS = ["slack", "github"] as const;

type UserLookupProvider = (typeof USER_LOOKUP_PROVIDERS)[number];

type UserLookupMatch = SlackUserProfile & { mention: string };

type UserLookupSearchMeta = {
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
};

type UserLookupResult = {
  provider: UserLookupProvider;
  query: string;
  count: number;
  mention?: string;
  user?: UserLookupMatch;
  users?: UserLookupMatch[];
} & Partial<UserLookupSearchMeta>;

function explicitUserLookupError(error: SlackActionError): string | undefined {
  if (error.apiError === "user_not_found" || error.code === "not_found") {
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

function slackMention(userId: string): string {
  return `<@${userId}>`;
}

function asMatch(user: SlackUserProfile): UserLookupMatch {
  return { ...user, mention: slackMention(user.id) };
}

function lookupResult(args: {
  provider: UserLookupProvider;
  query: string;
  users: SlackUserProfile[];
  search?: UserLookupSearchMeta;
}): UserLookupResult {
  const users = args.users.map(asMatch);
  if (users.length === 1) {
    return {
      provider: args.provider,
      query: args.query,
      count: 1,
      mention: users[0]!.mention,
      user: users[0],
      ...args.search,
    };
  }
  return {
    provider: args.provider,
    query: args.query,
    count: users.length,
    users,
    ...args.search,
  };
}

async function storeProfile(
  teamId: SlackTeamId,
  profile: SlackUserProfile,
): Promise<void> {
  await upsertIdentity(getSqlExecutor(), {
    kind: profile.is_bot ? "service" : "user",
    provider: "slack",
    providerTenantId: teamId,
    providerSubjectId: profile.id,
    displayName: profile.real_name || profile.display_name,
    handle: profile.name,
    ...(profile.email ? { email: profile.email, emailVerified: true } : {}),
  });
}

async function storedUserByEmail(
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
  const identity = identities[0];
  if (!identity) return undefined;
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

function looksLikeEmail(query: string): boolean {
  // Require local@domain so bare @handles stay name searches.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query);
}

async function resolveSlack(
  teamId: SlackTeamId,
  query: string,
): Promise<UserLookupResult> {
  const userId = parseSlackUserId(query);
  if (userId) {
    const user = await lookupSlackUserProfile(userId);
    await storeProfile(teamId, user);
    return lookupResult({ provider: "slack", query, users: [user] });
  }

  if (looksLikeEmail(query)) {
    const stored = await storedUserByEmail(teamId, query);
    if (stored) {
      return lookupResult({ provider: "slack", query, users: [stored] });
    }
    const profile = await lookupSlackUserByEmail(query);
    if (!profile) {
      throw new ToolInputError(
        `No Slack user found with email address ${query}.`,
      );
    }
    await storeProfile(teamId, profile);
    return lookupResult({ provider: "slack", query, users: [profile] });
  }

  const result = await searchSlackUsers({
    query,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  if (result.users.length === 1) {
    await storeProfile(teamId, result.users[0]!);
  }
  return lookupResult({
    provider: "slack",
    query,
    users: result.users,
    search: {
      searched_pages: result.searched_pages,
      searched_user_count: result.searched_user_count,
      truncated: result.truncated,
    },
  });
}

async function resolveGithub(
  teamId: SlackTeamId,
  query: string,
): Promise<UserLookupResult> {
  const githubUsername = normalizeGithubUsername(query);
  if (!githubUsername) {
    throw new ToolInputError(
      `Invalid GitHub username: ${query}. Use a login such as dcramer, @dcramer, or https://github.com/dcramer.`,
    );
  }

  const result = await searchSlackUsersByGithubUsername({
    githubUsername,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  if (result.users.length === 1) {
    await storeProfile(teamId, result.users[0]!);
  }
  return lookupResult({
    provider: "github",
    query: githubUsername,
    users: result.users,
    search: {
      searched_pages: result.searched_pages,
      searched_user_count: result.searched_user_count,
      truncated: result.truncated,
    },
  });
}

/** Create the tool that resolves people by identity provider and query. */
export function createUserLookupTool(teamId: SlackTeamId) {
  return zodTool({
    description:
      "Look up people by identity provider and query. Pass `provider` (`slack` or `github`) and a provider-specific `query` (Slack user ID, email, or name; GitHub login or profile URL). Returns Slack `mention` values (`<@U…>`) for the current workspace. Use a mention only when one person clearly matches; otherwise ask which person the user means.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        provider: z
          .enum(USER_LOOKUP_PROVIDERS)
          .describe("Identity provider to query: slack or github."),
        query: z
          .string()
          .trim()
          .min(2)
          .describe(
            "Provider-specific lookup value. For slack: user ID, email, or name. For github: login, @handle, or github.com profile URL.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ provider, query }) => {
      try {
        if (provider === "slack") {
          return await resolveSlack(teamId, query);
        }
        return await resolveGithub(teamId, query);
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
