import { z } from "zod";
import {
  resolvePersonForSlackMention,
  type PersonResolveMode,
  type ResolvedPersonMatch,
} from "@/chat/identities/resolve";
import { SlackActionError } from "@/chat/slack/client";
import { parseRequiredSlackUserIdParam } from "@/chat/slack/id-param";
import { parseSlackUserId } from "@/chat/slack/ids";
import { formatSlackUserMention } from "@/chat/slack/mrkdwn";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import {
  lookupSlackUserProfile,
  searchSlackUsers,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

type LookupMode = "user_id" | "email" | "query" | "github";

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

function resolveModeForLookup(
  mode: Exclude<LookupMode, "query">,
): PersonResolveMode {
  return mode === "user_id" ? "slack_user_id" : mode;
}

function withMention(profile: SlackUserProfile): SlackUserProfile & {
  mention?: string;
} {
  const mention = formatSlackUserMention(profile.id);
  return mention ? { ...profile, mention } : profile;
}

function profileFromResolved(
  person: ResolvedPersonMatch,
): SlackUserProfile & { mention?: string } {
  if (person.profile) {
    return withMention(person.profile);
  }
  const mention =
    person.mention || formatSlackUserMention(person.slack_user_id);
  return {
    id: person.slack_user_id,
    ...(person.handle ? { name: person.handle } : {}),
    ...(person.display_name ? { real_name: person.display_name } : {}),
    ...(person.display_name ? { display_name: person.display_name } : {}),
    ...(person.email ? { email: person.email } : {}),
    is_bot: person.is_bot ?? false,
    is_deleted: person.is_deleted ?? false,
    ...(mention ? { mention } : {}),
  };
}

async function enrichProfile(
  person: ResolvedPersonMatch,
): Promise<SlackUserProfile & { mention?: string }> {
  if (person.profile) {
    return withMention(person.profile);
  }
  const parsedUserId = parseSlackUserId(person.slack_user_id);
  if (parsedUserId) {
    try {
      return withMention(await lookupSlackUserProfile(parsedUserId));
    } catch {
      // Fall through to the stored/fallback profile shape.
    }
  }
  return profileFromResolved(person);
}

function uniqueLookupResult(args: {
  mode: Exclude<LookupMode, "query">;
  person: ResolvedPersonMatch;
  user: SlackUserProfile & { mention?: string };
}) {
  return {
    mode: args.mode,
    mention: args.person.mention,
    user: args.user,
    match: args.person.match,
    ...(args.person.user_id ? { user_id: args.person.user_id } : {}),
    ...(args.person.identity_id
      ? { identity_id: args.person.identity_id }
      : {}),
    ...(args.person.github_username
      ? { github_username: args.person.github_username }
      : {}),
  };
}

/** Create the tool that looks up workspace people and returns mention tokens. */
export function createSlackUserLookupTool(context: SlackToolContext) {
  return zodTool({
    description:
      "Look up a workspace person by Slack user ID, email, name/handle, or GitHub username. Returns profile fields and a ready-to-paste `mention` token (`<@U…>`) when the match is unique. Ambiguous or missing matches fail with candidates — do not invent plain-text @names.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        mode: z
          .enum(["user_id", "email", "query", "github"])
          .describe(
            "Lookup method: user_id for Slack IDs, email for email addresses, query for display name/handle search, or github for GitHub username.",
          ),
        value: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The person reference to look up, interpreted according to mode.",
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
        }

        // Name search keeps list/discovery semantics, including empty results.
        if (mode === "query") {
          const search = await searchSlackUsers({
            query: value,
            limit: 10,
            maxPages: 3,
            includeBots: false,
          });
          const users = search.users
            .filter((user) => !user.is_deleted)
            .map(withMention);
          if (users.length === 1) {
            return {
              mode,
              mention: users[0]?.mention,
              user: users[0],
              query: value,
              count: 1,
              searched_pages: search.searched_pages,
              searched_user_count: search.searched_user_count,
              truncated: search.truncated,
              users,
            };
          }
          return {
            mode,
            query: value,
            count: users.length,
            searched_pages: search.searched_pages,
            searched_user_count: search.searched_user_count,
            truncated: search.truncated,
            users,
          };
        }

        const result = await resolvePersonForSlackMention({
          teamId: context.teamId,
          mode: resolveModeForLookup(mode),
          value,
        });

        if (result.status === "resolved") {
          return uniqueLookupResult({
            mode,
            person: result.person,
            user: await enrichProfile(result.person),
          });
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
          mode === "email"
            ? `No Slack user found with email address ${value}.`
            : mode === "user_id"
              ? "No Slack user found for the supplied user ID."
              : `No person found for ${mode} ${JSON.stringify(value)} in this workspace.`,
        );
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
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
