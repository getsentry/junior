import { Type } from "@sinclair/typebox";
import { SlackActionError } from "@/chat/slack/client";
import {
  lookupSlackUserProfile,
  lookupSlackUserByEmail,
  searchSlackUsers,
} from "@/chat/slack/users";
import { tool } from "@/chat/tools/definition";

/** Create a read-only tool for looking up Slack user profiles by ID, email, or name search. */
export function createSlackUserLookupTool() {
  return tool({
    description:
      "Look up Slack user profiles by user ID, email, or name search. Use when you need to identify a user, find their GitHub handle, resolve cross-platform identity, or look up profile details like title or status. Returns profile fields including custom fields (e.g. GitHub URL). For user ID lookup, pass a Slack user ID (e.g. U039RR91S). For search, pass a name query.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      user_id: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Slack user ID to look up (e.g. U039RR91S). Mutually exclusive with email and query.",
        }),
      ),
      email: Type.Optional(
        Type.String({
          minLength: 3,
          description:
            "Email address to look up. Mutually exclusive with user_id and query.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          minLength: 2,
          description:
            "Name to search for (matches against username, display name, real name). Mutually exclusive with user_id and email.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description:
            "Maximum number of results to return for name search. Defaults to 10.",
        }),
      ),
      max_pages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 5,
          description:
            "Maximum number of Slack API pages to scan for name search. Defaults to 3.",
        }),
      ),
      include_bots: Type.Optional(
        Type.Boolean({
          description:
            "Include bot accounts in name search results. Defaults to false.",
        }),
      ),
    }),
    execute: async ({
      user_id,
      email,
      query,
      limit,
      max_pages,
      include_bots,
    }) => {
      // Validate mutually exclusive inputs
      const modes = [user_id, email, query].filter(Boolean);
      if (modes.length === 0) {
        return {
          ok: false,
          error:
            "Provide exactly one of user_id, email, or query to look up a Slack user.",
        };
      }
      if (modes.length > 1) {
        return {
          ok: false,
          error: "Only one of user_id, email, or query can be provided.",
        };
      }

      try {
        // Exact user ID lookup
        if (user_id) {
          const profile = await lookupSlackUserProfile(user_id);
          return {
            ok: true,
            mode: "user_id",
            user: profile,
          };
        }

        // Email lookup
        if (email) {
          const profile = await lookupSlackUserByEmail(email);
          if (!profile) {
            return {
              ok: false,
              mode: "email",
              email,
              error: "No Slack user found with that email address.",
            };
          }
          return {
            ok: true,
            mode: "email",
            user: profile,
          };
        }

        // Name search
        if (query) {
          const result = await searchSlackUsers({
            query,
            limit: limit ?? 10,
            maxPages: max_pages ?? 3,
            includeBots: include_bots ?? false,
          });

          return {
            ok: true,
            mode: "query",
            query,
            count: result.users.length,
            searched_pages: result.searched_pages,
            searched_user_count: result.searched_user_count,
            truncated: result.truncated,
            users: result.users,
          };
        }
      } catch (error) {
        if (error instanceof SlackActionError) {
          if (
            error.code === "missing_token" ||
            error.code === "missing_scope"
          ) {
            return {
              ok: false,
              error: `Slack API access issue: ${error.message}`,
              slack_error: error.apiError,
              ...(error.needed ? { needed_scope: error.needed } : {}),
            };
          }

          if (
            error.code === "not_found" ||
            error.apiError === "user_not_found" ||
            error.apiError === "users_not_found"
          ) {
            return {
              ok: false,
              error: "Slack user not found.",
              slack_error: error.apiError,
            };
          }

          return {
            ok: false,
            error: `Slack API error: ${error.message}`,
            slack_error: error.apiError,
            code: error.code,
          };
        }
        throw error;
      }

      return {
        ok: false,
        error: "Unexpected state: no lookup mode matched.",
      };
    },
  });
}
