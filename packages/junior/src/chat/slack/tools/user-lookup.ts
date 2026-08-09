import { z } from "zod";
import {
  resolveSlackUser,
  type ResolvedSlackUser,
} from "@/chat/identities/resolve";
import { SlackActionError } from "@/chat/slack/client";
import { parseRequiredSlackUserIdParam } from "@/chat/slack/id-param";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import type { SlackUserProfile } from "@/chat/slack/users";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

function explicitUserLookupError(error: SlackActionError): string | undefined {
  if (error.apiError === "user_not_found" || error.code === "not_found") {
    return "No Slack user found for the supplied user ID.";
  }
  if (error.code === "missing_scope") {
    return error.needed
      ? `Slack user lookup is unavailable because this installation is missing the \`${error.needed}\` scope.`
      : "Slack user lookup is unavailable because this installation is missing a required Slack scope.";
  }
  if (error.code === "invalid_arguments") {
    return `Slack rejected the user lookup arguments (${error.apiError ?? error.code}).`;
  }
  if (error.code === "feature_unavailable") {
    return "Slack user lookup is not available for this workspace or app installation.";
  }
  return undefined;
}

function profileFromResolved(
  resolved: ResolvedSlackUser,
): SlackUserProfile & { mention: string } {
  if (resolved.profile) {
    return { ...resolved.profile, mention: resolved.mention };
  }
  return {
    id: resolved.slackUserId,
    ...(resolved.handle ? { name: resolved.handle } : {}),
    ...(resolved.displayName ? { real_name: resolved.displayName } : {}),
    ...(resolved.displayName ? { display_name: resolved.displayName } : {}),
    ...(resolved.email ? { email: resolved.email } : {}),
    is_bot: false,
    is_deleted: false,
    mention: resolved.mention,
  };
}

function ambiguousMessage(
  value: string,
  candidates: Array<{
    slackUserId: string;
    displayName?: string;
    handle?: string;
  }>,
): string {
  return `More than one Slack user matches ${JSON.stringify(value)}: ${candidates
    .map((candidate) => {
      const label =
        candidate.handle || candidate.displayName || candidate.slackUserId;
      return `${label} (${candidate.slackUserId})`;
    })
    .join(", ")}. Ask which person to use.`;
}

/** Create the tool that looks up workspace people and returns mention tokens. */
export function createSlackUserLookupTool(context: SlackToolContext) {
  return zodTool({
    description:
      "Look up a Slack user by user ID, email, or name. Returns a `mention` token (`<@U…>`) when one user matches. If several users match, ask which person to use instead of guessing.",
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
          const parsed = parseRequiredSlackUserIdParam("value", value);
          if (!parsed.ok) throw new ToolInputError(parsed.error);
        }

        const result = await resolveSlackUser({
          teamId: context.teamId,
          mode,
          value,
        });
        if (result.status === "ambiguous") {
          throw new ToolInputError(ambiguousMessage(value, result.candidates));
        }
        if (result.status === "not_found") {
          throw new ToolInputError(
            mode === "email"
              ? `No Slack user found with email address ${value}.`
              : mode === "user_id"
                ? "No Slack user found for the supplied user ID."
                : `No Slack user found for name ${JSON.stringify(value)}.`,
          );
        }

        const user = profileFromResolved(result.user);
        return {
          mode,
          mention: result.user.mention,
          user,
          ...(mode === "query"
            ? {
                query: value,
                count: 1,
                users: [user],
              }
            : {}),
          identity_id: result.user.identityId,
          ...(result.user.userId ? { user_id: result.user.userId } : {}),
        };
      } catch (error) {
        if (error instanceof ToolInputError) throw error;
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
