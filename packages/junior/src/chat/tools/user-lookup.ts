import * as z from "zod";
import type { PluginEgress } from "@sentry/junior-plugin-api";
import {
  isSlackUserNotFound,
  lookupUsers,
  looksLikeEmail,
} from "@/chat/identities/user-lookup";
import { SlackActionError } from "@/chat/slack/client";
import type { SlackTeamId } from "@/chat/slack/ids";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

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

/** Static definition of `userLookup` for these identity providers. */
export function userLookupToolDefinition(providers: [string, ...string[]]) {
  return zodToolDefinition({
    description:
      "Look up people across identity providers, or in one. Name search can miss people in large workspaces. Each match is a Slack person with a `mention` (`<@U…>`), the providers that matched (`matched_providers`), `has_user` when you know them as a User, and the verified handles they linked (`linked_identities`), such as `github`. `accounts` lists provider accounts that no known person linked. When `ambiguous` is true, ask which person the user means.",
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
        const result = await lookupUsers({
          egress,
          provider,
          providers,
          query,
          teamId,
        });
        if (
          provider === "slack" &&
          result.count === 0 &&
          looksLikeEmail(query)
        ) {
          throw new ToolInputError(
            `No Slack user found with email address ${query}.`,
          );
        }
        return result;
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
