import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
} from "@/chat/slack/users";
import { SlackActionError } from "@/chat/slack/client";
import {
  parseRequiredSlackUserIdParam,
  slackUserIdParam,
} from "@/chat/slack/id-param";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

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

/** Create the tool that resolves Slack users by ID, handle, or email. */
export function createSlackUserLookupTool() {
  return zodTool({
    description:
      "Look up Slack user profiles by user ID, email, or name search. Use when you need to identify a user, resolve cross-platform identity, or look up profile details like title or status. Returns profile fields including custom fields. For user ID lookup, pass a Slack user ID (e.g. U039RR91S). For search, pass a name query.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      user_id: slackUserIdParam(
        "Slack user ID to look up (e.g. U039RR91S). Mutually exclusive with email and query.",
      ).optional(),
      email: z
        .string()
        .min(3)
        .describe(
          "Email address to look up. Mutually exclusive with user_id and query.",
        )
        .optional(),
      query: z
        .string()
        .min(2)
        .describe(
          "Name to search for (matches against username, display name, real name). Mutually exclusive with user_id and email.",
        )
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .describe(
          "Maximum number of results to return for name search. Defaults to 10.",
        )
        .optional(),
      max_pages: z.coerce
        .number()
        .int()
        .min(1)
        .max(5)
        .describe(
          "Maximum number of Slack API pages to scan for name search. Defaults to 3.",
        )
        .optional(),
      include_bots: booleanInput(
        "Include bot accounts in name search results. Defaults to false.",
      ).optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({
      user_id,
      email,
      query,
      limit,
      max_pages,
      include_bots,
    }) => {
      const modes = [user_id, email, query].filter(Boolean);
      if (modes.length === 0) {
        throw new ToolInputError(
          "Provide exactly one of user_id, email, or query to look up a Slack user.",
        );
      }
      if (modes.length > 1) {
        throw new ToolInputError(
          "Only one of user_id, email, or query can be provided.",
        );
      }

      try {
        if (user_id) {
          const parsedUserId = parseRequiredSlackUserIdParam(
            "user_id",
            user_id,
          );
          if (!parsedUserId.ok) {
            throw new ToolInputError(parsedUserId.error);
          }

          return {
            mode: "user_id",
            user: await lookupSlackUserProfile(parsedUserId.value),
          };
        }

        if (email) {
          const profile = await lookupSlackUserByEmail(email);
          if (!profile) {
            throw new ToolInputError(
              `No Slack user found with email address ${email}.`,
            );
          }
          return {
            mode: "email",
            user: profile,
          };
        }

        const result = await searchSlackUsers({
          query: query!,
          limit: limit ?? 10,
          maxPages: max_pages ?? 3,
          includeBots: include_bots ?? false,
        });

        return {
          mode: "query",
          query,
          count: result.users.length,
          searched_pages: result.searched_pages,
          searched_user_count: result.searched_user_count,
          truncated: result.truncated,
          users: result.users,
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
