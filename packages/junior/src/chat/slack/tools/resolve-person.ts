import { z } from "zod";
import { resolvePersonForSlackMention } from "@/chat/identities/resolve";
import { SlackActionError } from "@/chat/slack/client";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

function resolvePersonError(error: SlackActionError): string | undefined {
  if (error.apiError === "user_not_found" || error.code === "not_found") {
    return "No Slack user found for that person reference.";
  }
  if (error.code === "missing_scope") {
    return error.needed
      ? `Person resolve is unavailable because this installation is missing the \`${error.needed}\` scope.`
      : "Person resolve is unavailable because this installation is missing a required Slack scope.";
  }
  if (error.code === "feature_unavailable") {
    return "Person resolve is not available for this workspace or app installation.";
  }
  return undefined;
}

/** Create the tool that resolves people to identity-backed Slack mentions. */
export function createResolvePersonTool(context: SlackToolContext) {
  return zodTool({
    description:
      "Resolve a person reference to a workspace Slack mention. Lookup by Slack user ID, email, display name/handle, or GitHub username. Returns a ready-to-paste `mention` token (`<@U…>`). Ambiguous or missing matches fail with candidates or not_found — do not guess. Prefer this over inventing plain-text @names.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        mode: z
          .enum(["slack_user_id", "email", "query", "github"])
          .describe(
            "Lookup method: slack_user_id for Slack IDs, email for email addresses, query for display name/handle search, or github for GitHub username.",
          ),
        value: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The person reference to resolve, interpreted according to mode.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ mode, value }) => {
      try {
        const result = await resolvePersonForSlackMention({
          teamId: context.teamId,
          mode,
          value,
        });

        if (result.status === "resolved") {
          return {
            status: "resolved",
            person: result.person,
          };
        }

        if (result.status === "ambiguous") {
          throw new ToolInputError(
            `Ambiguous person match for ${mode} ${JSON.stringify(value)}. Candidates: ${result.candidates
              .map((candidate) => {
                const label =
                  candidate.handle ||
                  candidate.display_name ||
                  candidate.slack_user_id;
                return `${label} (${candidate.slack_user_id})`;
              })
              .join(", ")}. Ask which person to use.`,
          );
        }

        throw new ToolInputError(
          `No person found for ${mode} ${JSON.stringify(value)} in this workspace.`,
        );
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        if (error instanceof SlackActionError) {
          const message = resolvePersonError(error);
          if (message) {
            throw new ToolInputError(message, { cause: error });
          }
        }
        throw error;
      }
    },
  });
}
