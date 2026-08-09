import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
} from "@/chat/slack/users";
import { SlackActionError } from "@/chat/slack/client";
import { parseRequiredSlackUserIdParam } from "@/chat/slack/id-param";
import { z } from "zod";
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

/** Create the tool that resolves Slack users by ID, handle, or email. */
export function createSlackUserLookupTool() {
  return zodTool({
    description:
      "Look up Slack user profiles by user ID, email, or name search. Set mode to match the identifier in value. Returns profile fields and the Slack `mention` format (`<@U…>`).",
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
          return {
            mode: "user_id",
            mention: slackMention(user.id),
            user,
          };
        }

        if (mode === "email") {
          const profile = await lookupSlackUserByEmail(value);
          if (!profile) {
            throw new ToolInputError(
              `No Slack user found with email address ${value}.`,
            );
          }
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
