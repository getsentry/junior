import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { upsertIdentity } from "@/chat/identities/sql";
import { SlackActionError } from "@/chat/slack/client";
import { parseRequiredSlackUserIdParam } from "@/chat/slack/id-param";
import type { SlackTeamId } from "@/chat/slack/ids";
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

function explicitUserLookupError(error: SlackActionError): string | undefined {
  if (error.apiError === "user_not_found") {
    return "No Slack user found for the supplied user ID.";
  }
  if (error.code === "missing_scope") {
    return error.needed
      ? `Slack user lookup is unavailable because this installation is missing the \`${error.needed}\` scope.`
      : "Slack user lookup is unavailable because this installation is missing a required Slack scope.";
  }
  if (error.code === "not_found") {
    return "No Slack user found for the supplied user ID.";
  }
  if (error.code === "invalid_arguments") {
    return `Slack rejected the user lookup arguments (${error.apiError ?? error.code}).`;
  }
  if (error.code === "feature_unavailable") {
    return "Slack user lookup is not available for this workspace or app installation.";
  }
  return undefined;
}

function slackMention(userId: string): string {
  return `<@${userId}>`;
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
  // Only reuse a stored identity when the email maps to exactly one person.
  if (identities.length !== 1) return undefined;
  const identity = identities[0]!;
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

/** Create the tool that resolves Slack users by ID, handle, or email. */
export function createSlackUserLookupTool(teamId: SlackTeamId) {
  return zodTool({
    description:
      "Look up Slack user profiles by user ID, email, or name search. Returns Slack `mention` values (`<@U…>`). Use a mention only when one person clearly matches; otherwise ask which person the user means.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        mode: z
          .enum(["user_id", "email", "query"])
          .describe(
            "Lookup method: user_id for Slack IDs, email for email addresses, or query for name searches.",
          ),
        value: z
          .string()
          .trim()
          .min(2)
          .describe(
            "The Slack user ID, email address, or name to look up, interpreted according to mode.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ mode, value }) => {
      try {
        if (mode === "user_id") {
          const parsedUserId = parseRequiredSlackUserIdParam("value", value);
          if (!parsedUserId.ok) {
            throw new ToolInputError(parsedUserId.error);
          }

          const user = await lookupSlackUserProfile(parsedUserId.value);
          await storeProfile(teamId, user);
          return {
            mode: "user_id",
            mention: slackMention(user.id),
            user,
          };
        }

        if (mode === "email") {
          const stored = await storedUserByEmail(teamId, value);
          if (stored) {
            return {
              mode: "email",
              mention: slackMention(stored.id),
              user: stored,
            };
          }

          const profile = await lookupSlackUserByEmail(value);
          if (!profile) {
            throw new ToolInputError(
              `No Slack user found with email address ${value}.`,
            );
          }
          await storeProfile(teamId, profile);
          return {
            mode: "email",
            mention: slackMention(profile.id),
            user: profile,
          };
        }

        const result = await searchSlackUsers({
          query: value,
          limit: 10,
          maxPages: 3,
          includeBots: false,
        });
        if (result.users.length === 1) {
          await storeProfile(teamId, result.users[0]!);
        }

        return {
          mode: "query",
          query: value,
          count: result.users.length,
          searched_pages: result.searched_pages,
          searched_user_count: result.searched_user_count,
          truncated: result.truncated,
          users: result.users.map((user) => ({
            ...user,
            mention: slackMention(user.id),
          })),
        };
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
