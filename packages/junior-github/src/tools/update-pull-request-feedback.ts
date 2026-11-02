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
 * GitHub has reactions but no feedback state. This tool maps each state to a
 * reaction and keeps at most one state reaction that Junior owns. It does not
 * change reactions from other users.
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
type FeedbackOutcome = Exclude<FeedbackStatus, "reviewing">;
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
      .enum(["addressed", "declined"])
      .describe(
        "Feedback outcome. Maps to a reaction: addressed -> +1, declined -> -1.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("updatePullRequestFeedback"),
  repo: z.string(),
  commentId: z.number(),
  status: z.enum(["addressed", "declined"]),
  reactionId: z.number(),
});
interface Result extends PluginToolOutput {
  target: "updatePullRequestFeedback";
  repo: string;
  commentId: number;
  status: FeedbackOutcome;
  reactionId: number;
}

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

interface PullRequestCommentRef {
  owner: string;
  name: string;
  commentKind: PullRequestCommentKind;
  commentId: number;
}

function pullRequestCommentPath(input: PullRequestCommentRef): string {
  // Conversation comments live under the issues endpoint; inline review
  // comments live under the pulls endpoint. GitHub has no shared path.
  const segment = input.commentKind === "conversation" ? "issues" : "pulls";
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/${segment}/comments/${input.commentId}`;
}

/** Build the GitHub API path for one pull request comment's reactions. */
export function pullRequestCommentReactionsPath(
  input: PullRequestCommentRef,
): string {
  return `${pullRequestCommentPath(input)}/reactions`;
}

/** Return the GitHub reaction for one feedback state. */
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
 * Refuse feedback on a comment unless GitHub shows that the comment is on a
 * pull request in `repo` that the bot authored. A conversation comment is an
 * issue comment, so its issue must also be a pull request.
 */
async function assertBotAuthoredPullRequest(
  egress: PluginEgress,
  input: PullRequestCommentRef & { botUserId: number },
): Promise<void> {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const commentResponse = await egress.fetch({
    provider: "github",
    operation: "github.pull.comment.get",
    request: new Request(
      `https://api.github.com${pullRequestCommentPath(input)}`,
      { headers },
    ),
  });
  const commentPayload = await readJson(commentResponse);
  if (!commentResponse.ok) {
    const message = `GitHub comment lookup failed with HTTP ${commentResponse.status}: ${githubError(commentPayload)}`;
    if (commentResponse.status === 404) throw new PluginToolInputError(message);
    throw new Error(message);
  }
  const comment = z
    .object({
      issue_url: z.string().optional(),
      pull_request_url: z.string().optional(),
    })
    .safeParse(commentPayload);
  const parentUrl = comment.success
    ? input.commentKind === "conversation"
      ? comment.data.issue_url
      : comment.data.pull_request_url
    : undefined;
  // The comment endpoint is scoped to `repo`, so only the number is read.
  const number = /\/(?:issues|pulls)\/(\d+)$/.exec(parentUrl ?? "")?.[1];
  if (!number) {
    throw new Error("GitHub comment did not name its issue or pull request.");
  }

  // GitHub returns 404 here when the conversation comment is on an issue.
  const pullResponse = await egress.fetch({
    provider: "github",
    operation: "github.pull.get",
    request: new Request(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/pulls/${number}`,
      { headers },
    ),
  });
  const pullPayload = await readJson(pullResponse);
  if (!pullResponse.ok && pullResponse.status !== 404) {
    throw new Error(
      `GitHub pull request lookup failed with HTTP ${pullResponse.status}: ${githubError(pullPayload)}`,
    );
  }
  const pull = z
    .object({ user: z.object({ id: z.number() }).nullable() })
    .safeParse(pullPayload);
  if (
    !pullResponse.ok ||
    !pull.success ||
    pull.data.user?.id !== input.botUserId
  ) {
    throw new PluginToolInputError(
      "This bot can only set feedback status on comments on pull requests it authored.",
    );
  }
}

/**
 * Set Junior's feedback reaction on a pull request comment. Replace only
 * state reactions Junior previously added to the same comment.
 */
export function createGitHubUpdatePullRequestFeedbackTool(
  ctx: { egress: PluginEgress },
  botEmail: string | undefined,
) {
  return definePluginTool({
    // No action review: the tool checks in code that the bot authored the pull
    // request, and it changes only the bot's own reaction, which is reversible.
    approvalMode: "approve",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Set your outcome reaction on GitHub pull request feedback: addressed (+1) or declined (-1). Use the commentId and commentKind from the event after acting on the feedback. Replaces only your prior status reaction on that comment. Only works on pull requests the bot authored.",
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
      await assertBotAuthoredPullRequest(ctx.egress, {
        owner: repo.owner,
        name: repo.name,
        commentKind,
        commentId,
        botUserId,
      });
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
