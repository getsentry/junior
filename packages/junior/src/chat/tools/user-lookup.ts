import { and, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { SlackActionError } from "@/chat/slack/client";
import { parseSlackUserId, type SlackTeamId } from "@/chat/slack/ids";
import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { juniorIdentities } from "@/db/schema";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const linkedSlackIdentity = alias(juniorIdentities, "user_lookup_slack_identity");

type UserLookupProfile = SlackUserProfile | Pick<SlackUserProfile, "id" | "name">;
type UserLookupMatch = UserLookupProfile & { mention: string };

type UserLookupSearchMeta = {
  searched_pages: number;
  searched_user_count: number;
  truncated: boolean;
};

type UserLookupResult = {
  provider: string;
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

function asMatch(user: UserLookupProfile): UserLookupMatch {
  return { ...user, mention: slackMention(user.id) };
}

function lookupResult(args: {
  provider: string;
  query: string;
  users: UserLookupProfile[];
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
    is_external: false,
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
    return lookupResult({ provider: "slack", query, users: [user] });
  }

  if (looksLikeEmail(query)) {
    const stored = await storedSlackUserByEmail(teamId, query);
    if (stored) {
      return lookupResult({ provider: "slack", query, users: [stored] });
    }
    const profile = await lookupSlackUserByEmail(query);
    if (!profile) {
      throw new ToolInputError(
        `No Slack user found with email address ${query}.`,
      );
    }
    return lookupResult({ provider: "slack", query, users: [profile] });
  }

  const result = await searchSlackUsers({
    query,
    limit: 10,
    maxPages: 3,
    includeBots: false,
  });
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

async function resolveStoredProvider(
  teamId: SlackTeamId,
  provider: string,
  query: string,
): Promise<UserLookupResult> {
  const rows = await getSqlExecutor()
    .db()
    .select({ slack: linkedSlackIdentity })
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
        eq(juniorIdentities.provider, provider),
        or(
          eq(juniorIdentities.providerSubjectId, query),
          sql`lower(${juniorIdentities.handle}) = lower(${query})`,
        ),
      ),
    )
    .limit(11);
  const users = rows
    .slice(0, 10)
    .map((row) => slackMentionProfileFromIdentity(row.slack));
  return lookupResult({ provider, query, users });
}

/** Create the tool that resolves people by identity provider and query. */
export function createUserLookupTool(
  teamId: SlackTeamId,
  providers: [string, ...string[]],
) {
  return zodTool({
    description:
      "Look up people by identity provider and query. Pass an enabled `provider` and its provider subject ID or handle. The `slack` provider also accepts email and name searches. Returns Slack `mention` values (`<@U…>`) for the current workspace. Use a mention only when one person clearly matches; otherwise ask which person the user means.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        provider: z.enum(providers).describe("Enabled identity provider to query."),
        query: z
          .string()
          .trim()
          .min(1)
          .describe("Provider subject ID, handle, Slack email, or Slack name."),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ provider, query }) => {
      try {
        return provider === "slack"
          ? await resolveSlack(teamId, query)
          : await resolveStoredProvider(teamId, provider, query);
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
