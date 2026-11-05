import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { botUserIdFromEmail } from "../webhooks/ownership.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";

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
    comment_kind: z
      .enum(["conversation", "review"])
      .describe(
        'Comment kind: "conversation" for a pull request conversation comment, "review" for an inline review comment.',
      ),
    comment_id: z
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
  comment_id: z.number(),
  status: z.enum(["addressed", "declined"]),
  reaction_id: z.number(),
});
interface Result extends PluginToolOutput {
  target: "updatePullRequestFeedback";
  repo: string;
  comment_id: number;
  status: FeedbackOutcome;
  reaction_id: number;
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
  const commentResponse = await githubApi(egress, {
    operation: "github.pull.comment.get",
    path: pullRequestCommentPath(input),
  });
  const commentPayload = commentResponse.body;
  if (!commentResponse.ok) {
    const message = `GitHub comment lookup failed with HTTP ${commentResponse.status}: ${githubErrorMessage(commentPayload)}`;
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
  const pullResponse = await githubApi(egress, {
    operation: "github.pull.get",
    path: `${repoPath(input)}/pulls/${number}`,
  });
  const pullPayload = pullResponse.body;
  if (!pullResponse.ok && pullResponse.status !== 404) {
    throw new Error(
      `GitHub pull request lookup failed with HTTP ${pullResponse.status}: ${githubErrorMessage(pullPayload)}`,
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
      "Set your outcome reaction on GitHub pull request feedback: addressed (+1) or declined (-1). Use the comment_id and comment_kind from the event after acting on the feedback. Replaces only your prior status reaction on that comment. Only works on pull requests the bot authored.",
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
      const {
        comment_id: commentId,
        comment_kind: commentKind,
        status,
      } = parsedInput.data;
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
      const reactionsPath = pullRequestCommentReactionsPath({
        owner: repo.owner,
        name: repo.name,
        commentKind,
        commentId,
      });

      const listResponse = await githubApi(ctx.egress, {
        operation: "github.pull.comment-reaction.list",
        path: `${reactionsPath}?per_page=100`,
      });
      const listPayload = listResponse.body;
      if (!listResponse.ok) {
        throw new Error(
          `GitHub reaction lookup failed with HTTP ${listResponse.status}: ${githubErrorMessage(listPayload)}`,
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
        const deleteResponse = await githubApi(ctx.egress, {
          operation: "github.pull.comment-reaction.delete",
          method: "DELETE",
          path: `${reactionsPath}/${stale.id}`,
        });
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          throw new Error(
            `GitHub reaction removal failed with HTTP ${deleteResponse.status}: ${githubErrorMessage(deleteResponse.body)}`,
          );
        }
      }

      if (existing) {
        return {
          target: "updatePullRequestFeedback",
          repo: repo.ref,
          comment_id: commentId,
          status,
          reaction_id: existing.id,
        };
      }

      const createResponse = await githubApi(ctx.egress, {
        operation: "github.pull.comment-reaction.create",
        method: "POST",
        path: reactionsPath,
        body: { content: targetContent },
      });
      const createPayload = createResponse.body;
      if (!createResponse.ok) {
        throw new Error(
          `GitHub reaction creation failed with HTTP ${createResponse.status}: ${githubErrorMessage(createPayload)}`,
        );
      }
      const created = reactionSchema.parse(createPayload);
      return {
        target: "updatePullRequestFeedback",
        repo: repo.ref,
        comment_id: commentId,
        status,
        reaction_id: created.id,
      };
    },
  });
}
