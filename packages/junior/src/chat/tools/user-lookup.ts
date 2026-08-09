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

/** Built-in identity providers the model may query today. */
export const USER_LOOKUP_PROVIDERS = ["slack", "github"] as const;
export type UserLookupProvider = (typeof USER_LOOKUP_PROVIDERS)[number];

type UserLookupMatch = SlackUserProfile & { mention: string };

type UserLookupResult = {
  provider: UserLookupProvider;
  query: string;
  count: number;
  searched_pages?: number;
  searched_user_count?: number;
  truncated?: boolean;
  mention?: string;
  user?: UserLookupMatch;
  users?: UserLookupMatch[];
};

type UserLookupContext = {
  teamId: SlackTeamId;
};

type UserLookupResolver = (
  query: string,
  context: UserLookupContext,
) => Promise<UserLookupResult>;

function explicitUserLookupError(error: SlackActionError): string | undefined {
  if (error.apiError === "user_not_found") {
    return "No Slack user found for the supplied user ID.";
  }
  if (error.code === "missing_scope") {
    return error.needed
      ? `User lookup is unavailable because this installation is missing the \`${error.needed}\` scope.`
      : "User lookup is unavailable because this installation is missing a required Slack scope.";
  }
  if (error.code === "not_found") {
    return "No Slack user found for the supplied user ID.";
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

function withMention(user: SlackUserProfile): UserLookupMatch {
  return {
    ...user,
    mention: slackMention(user.id),
  };
}

function withMentions(users: SlackUserProfile[]): UserLookupMatch[] {
  return users.map(withMention);
}

function singleOrMany(args: {
  provider: UserLookupProvider;
  query: string;
  users: SlackUserProfile[];
  searched_pages?: number;
  searched_user_count?: number;
  truncated?: boolean;
}): UserLookupResult {
  const users = withMentions(args.users);
  if (users.length === 1) {
    return {
      provider: args.provider,
      query: args.query,
      count: 1,
      mention: users[0]!.mention,
      user: users[0],
      ...(args.searched_pages !== undefined
        ? { searched_pages: args.searched_pages }
        : {}),
      ...(args.searched_user_count !== undefined
        ? { searched_user_count: args.searched_user_count }
        : {}),
      ...(args.truncated !== undefined ? { truncated: args.truncated } : {}),
    };
  }
  return {
    provider: args.provider,
    query: args.query,
    count: users.length,
    users,
    ...(args.searched_pages !== undefined
      ? { searched_pages: args.searched_pages }
      : {}),
    ...(args.searched_user_count !== undefined
      ? { searched_user_count: args.searched_user_count }
      : {}),
    ...(args.truncated !== undefined ? { truncated: args.truncated } : {}),
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
    ...(profile.real_name || profile.display_name
      ? { displayName: profile.real_name || profile.display_name }
      : {}),
    ...(profile.name ? { handle: profile.name } : {}),
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
    ...(identity.handle ? { name: identity.handle } : {}),
    ...(identity.displayName ? { real_name: identity.displayName } : {}),
    ...(identity.displayName ? { display_name: identity.displayName } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    is_bot: false,
    is_deleted: false,
  };
}

function looksLikeEmail(query: string): boolean {
  // Require local@domain so bare @handles stay name searches.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query);
}

async function resolveSlackQuery(
  query: string,
  context: UserLookupContext,
): Promise<UserLookupResult> {
  const userId = parseSlackUserId(query);
  if (userId) {
    const user = await lookupSlackUserProfile(userId);
    await storeProfile(context.teamId, user);
    return singleOrMany({
      provider: "slack",
      query,
      users: [user],
    });
  }

  if (looksLikeEmail(query)) {
    const stored = await storedUserByEmail(context.teamId, query);
    if (stored) {
      return singleOrMany({
        provider: "slack",
        query,
        users: [stored],
      });
    }

    const profile = await lookupSlackUserByEmail(query);
    if (!profile) {
      throw new ToolInputError(
        `No Slack user found with email address ${query}.`,
      );
    }
    await storeProfile(context.teamId, profile);
    return singleOrMany({
      provider: "slack",
      query,
      users: [profile],
    });
  }

  const result = await searchSlackUsers({
    query,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  if (result.users.length === 1) {
    await storeProfile(context.teamId, result.users[0]!);
  }
  return singleOrMany({
    provider: "slack",
    query,
    users: result.users,
    searched_pages: result.searched_pages,
    searched_user_count: result.searched_user_count,
    truncated: result.truncated,
  });
}

async function resolveGithubQuery(
  query: string,
  context: UserLookupContext,
): Promise<UserLookupResult> {
  const normalized = normalizeGithubUsername(query);
  if (!normalized) {
    throw new ToolInputError(
      `Invalid GitHub username: ${query}. Use a login such as dcramer, @dcramer, or https://github.com/dcramer.`,
    );
  }

  const result = await searchSlackUsersByGithubUsername({
    username: normalized,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
  if (result.users.length === 1) {
    await storeProfile(context.teamId, result.users[0]!);
  }
  return singleOrMany({
    provider: "github",
    query: normalized,
    users: result.users,
    searched_pages: result.searched_pages,
    searched_user_count: result.searched_user_count,
    truncated: result.truncated,
  });
}

const USER_LOOKUP_RESOLVERS: Record<UserLookupProvider, UserLookupResolver> = {
  slack: resolveSlackQuery,
  github: resolveGithubQuery,
};

/** Create the tool that resolves people across identity providers. */
export function createUserLookupTool(teamId: SlackTeamId) {
  const providerSchema = z.enum(USER_LOOKUP_PROVIDERS);
  return zodTool({
    description:
      "Look up people by identity provider and query. Pass provider such as `slack` or `github`, and a provider-specific query (Slack user ID, email, or name; GitHub login or profile URL). Returns Slack `mention` values (`<@U…>`) for the current workspace. Use a mention only when one person clearly matches; otherwise ask which person the user means.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        provider: providerSchema.describe(
          "Identity provider to query. Built-ins: slack, github. Plugins may add more providers over time.",
        ),
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
        return await USER_LOOKUP_RESOLVERS[provider](query, { teamId });
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
