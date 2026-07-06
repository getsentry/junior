import { SlackActionError } from "@/chat/slack/client";
import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
} from "@/chat/slack/users";
import {
  parseRequiredSlackUserIdParam,
  slackUserIdParam,
} from "@/chat/slack/id-param";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

/** Create the tool that resolves Slack users by ID, handle, or email. */
export function createSlackUserLookupTool() {
  return zodTool({
    description:
      "Look up Slack user profiles by user ID, email, or name search. Use when you need to identify a user, resolve cross-platform identity, or look up profile details like title or status. Returns profile fields including custom fields. For user ID lookup, pass a Slack user ID (e.g. U039RR91S). For search, pass a name query.",
    annotations: { readOnlyHint: true, destructiveHint: false },
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
    outputSchema: juniorToolResultSchema,
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
        return {
          ok: false,
          status: "error" as const,
          error:
            "Provide exactly one of user_id, email, or query to look up a Slack user.",
        };
      }
      if (modes.length > 1) {
        return {
          ok: false,
          status: "error" as const,
          error: "Only one of user_id, email, or query can be provided.",
        };
      }

      try {
        if (user_id) {
          const parsedUserId = parseRequiredSlackUserIdParam(
            "user_id",
            user_id,
          );
          if (!parsedUserId.ok) {
            return {
              ok: false,
              status: "error" as const,
              error: parsedUserId.error,
            };
          }

          return {
            ok: true,
            status: "success" as const,
            mode: "user_id",
            user: await lookupSlackUserProfile(parsedUserId.value),
          };
        }

        if (email) {
          const profile = await lookupSlackUserByEmail(email);
          if (!profile) {
            return {
              ok: false,
              status: "error" as const,
              mode: "email",
              email,
              error: "No Slack user found with that email address.",
            };
          }
          return {
            ok: true,
            status: "success" as const,
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
          ok: true,
          status: "success" as const,
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
          return {
            ok: false,
            status: "error" as const,
            error: error.message,
            slack_error: error.apiError,
            code: error.code,
            ...(error.needed ? { needed_scope: error.needed } : {}),
          };
        }
        throw error;
      }
    },
  });
}
