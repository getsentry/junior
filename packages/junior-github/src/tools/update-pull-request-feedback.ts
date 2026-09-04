import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { botUserIdFromEmail } from "../webhooks/ownership.js";

/**
 * GitHub has no dedicated feedback-status concept, only reactions. This tool
 * maps a feedback status to the matching reaction content and keeps at most
 * one status reaction that Junior owns on the comment. It never touches
 * reactions left by other users.
 */
const STATUS_TO_REACTION_CONTENT = {
  reviewing: "eyes",
  addressed: "+1",
  declined: "-1",
} as const;
const FEEDBACK_REACTION_CONTENTS = new Set<string>(
  Object.values(STATUS_TO_REACTION_CONTENT),
);
type FeedbackStatus = keyof typeof STATUS_TO_REACTION_CONTENT;
type PullRequestCommentKind = "conversation" | "review";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    commentKind: z
      .enum(["conversation", "review"])
      .describe(
        'Comment kind: "conversation" for a pull request conversation comment, "review" for an inline review comment.',
      ),
    commentId: z
      .number()
      .int()
      .positive()
      .describe(
        "GitHub comment id (conversation comment id or inline review comment id).",
      ),
    status: z
      .enum(["reviewing", "addressed", "declined"])
      .describe(
        "Feedback status. Maps to a reaction: reviewing -> eyes, addressed -> +1, declined -> -1.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("updatePullRequestFeedback"),
  repo: z.string(),
  commentId: z.number(),
  status: z.enum(["reviewing", "addressed", "declined"]),
  reactionId: z.number(),
});
interface Result extends PluginToolOutput {
  target: "updatePullRequestFeedback";
  repo: string;
  commentId: number;
  status: FeedbackStatus;
  reactionId: number;
}

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

/** Build the GitHub API path for one pull request comment's reactions. */
export function pullRequestCommentReactionsPath(input: {
  owner: string;
  name: string;
  commentKind: PullRequestCommentKind;
  commentId: number;
}): string {
  // Conversation comments live under the issues endpoint; inline review
  // comments live under the pulls endpoint. GitHub has no shared path.
  const segment = input.commentKind === "conversation" ? "issues" : "pulls";
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/${segment}/comments/${input.commentId}/reactions`;
}

/** Return the GitHub reaction content for one feedback status. */
export function pullRequestFeedbackReactionContent(
  status: FeedbackStatus,
): (typeof STATUS_TO_REACTION_CONTENT)[FeedbackStatus] {
  return STATUS_TO_REACTION_CONTENT[status];
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubError(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "GitHub request failed";
}

const reactionSchema = z.object({
  id: z.number(),
  content: z.string(),
  user: z.object({ id: z.number() }).nullable(),
});

/**
 * Set Junior's feedback-status reaction on a pull request comment. Replaces
 * only reactions Junior previously added to the same comment.
 */
export function createGitHubUpdatePullRequestFeedbackTool(
  ctx: { egress: PluginEgress },
  botEmail: string | undefined,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Set Junior's status reaction on GitHub pull request feedback: reviewing (eyes), addressed (+1), or declined (-1). Use the commentId and commentKind from the resource event. Replaces only Junior's prior status reaction on that comment.",
    exposure: "direct",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub updatePullRequestFeedback input.",
          { cause: parsedInput.error },
        );
      }
      const { commentId, commentKind, status } = parsedInput.data;
      const repo = parseRepo(parsedInput.data.repo);
      const botUserId = botUserIdFromEmail(botEmail);
      if (botUserId === undefined) {
        throw new Error("GitHub App bot identity is not configured.");
      }
      const targetContent = pullRequestFeedbackReactionContent(status);
      const baseUrl = `https://api.github.com${pullRequestCommentReactionsPath({
        owner: repo.owner,
        name: repo.name,
        commentKind,
        commentId,
      })}`;

      const listResponse = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.comment-reaction.list",
        request: new Request(`${baseUrl}?per_page=100`, {
          headers: { Accept: "application/vnd.github+json" },
        }),
      });
      const listPayload = await readJson(listResponse);
      if (!listResponse.ok) {
        throw new Error(
          `GitHub reaction lookup failed with HTTP ${listResponse.status}: ${githubError(listPayload)}`,
        );
      }
      const botReactions = z
        .array(reactionSchema)
        .parse(listPayload)
        .filter(
          (reaction) =>
            reaction.user?.id === botUserId &&
            FEEDBACK_REACTION_CONTENTS.has(reaction.content),
        );
      const existing = botReactions.find(
        (reaction) => reaction.content === targetContent,
      );

      for (const stale of botReactions) {
        if (stale.content === targetContent) continue;
        const deleteResponse = await ctx.egress.fetch({
          provider: "github",
          operation: "github.pull.comment-reaction.delete",
          request: new Request(`${baseUrl}/${stale.id}`, {
            method: "DELETE",
          }),
        });
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          const deletePayload = await readJson(deleteResponse);
          throw new Error(
            `GitHub reaction removal failed with HTTP ${deleteResponse.status}: ${githubError(deletePayload)}`,
          );
        }
      }

      if (existing) {
        return {
          target: "updatePullRequestFeedback",
          repo: repo.ref,
          commentId,
          status,
          reactionId: existing.id,
        };
      }

      const createResponse = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.comment-reaction.create",
        request: new Request(baseUrl, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: targetContent }),
        }),
      });
      const createPayload = await readJson(createResponse);
      if (!createResponse.ok) {
        throw new Error(
          `GitHub reaction creation failed with HTTP ${createResponse.status}: ${githubError(createPayload)}`,
        );
      }
      const created = reactionSchema.parse(createPayload);
      return {
        target: "updatePullRequestFeedback",
        repo: repo.ref,
        commentId,
        status,
        reactionId: created.id,
      };
    },
  });
}
