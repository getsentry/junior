import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
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
type PullRequestCommentKind = "conversation" | "review" | "review_body";

/**
 * GitHub has no REST reactions endpoint for a review body, so review bodies
 * use the GraphQL reaction names.
 */
const STATUS_TO_GRAPHQL_REACTION = {
  reviewing: "EYES",
  addressed: "THUMBS_UP",
  declined: "THUMBS_DOWN",
} as const;

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    comment_kind: z
      .enum(["conversation", "review", "review_body"])
      .describe(
        'Comment kind: "conversation" for a pull request conversation comment, "review" for an inline review comment, "review_body" for the body of a submitted review.',
      ),
    comment_id: z
      .number()
      .int()
      .positive()
      .describe(
        "GitHub comment id (conversation comment id, inline review comment id, or review id).",
      ),
    pull_request: z
      .number()
      .int()
      .positive()
      .describe("Pull request number that the comment is on."),
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
  reaction_id: z.number().optional(),
});
interface Result extends PluginToolOutput {
  target: "updatePullRequestFeedback";
  repo: string;
  comment_id: number;
  status: FeedbackOutcome;
  reaction_id?: number;
}

interface PullRequestCommentRef {
  owner: string;
  name: string;
  commentKind: Exclude<PullRequestCommentKind, "review_body">;
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
 * Return the issue or pull request number of one comment in `repo`. A
 * conversation comment is an issue comment, so its issue can be a plain issue.
 */
async function commentParentNumber(
  egress: PluginEgress,
  input: PullRequestCommentRef,
): Promise<string> {
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
  return number;
}

/**
 * Refuse feedback unless GitHub shows that `number` is a pull request in
 * `repo` that the bot authored.
 */
async function assertBotAuthoredPullRequest(
  egress: PluginEgress,
  input: {
    botUserId: number;
    name: string;
    number: number;
    owner: string;
  },
): Promise<void> {
  const { number } = input;
  // GitHub returns 404 here when the number is a plain issue.
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

/** Build the GitHub API path for one pull request review. */
export function pullRequestReviewPath(input: {
  owner: string;
  name: string;
  pullRequest: number;
  reviewId: number;
}): string {
  return `${repoPath(input)}/pulls/${input.pullRequest}/reviews/${input.reviewId}`;
}

/** The GraphQL mutation that adds one reaction to a review body. */
export const ADD_REVIEW_REACTION_MUTATION = `mutation AddReviewReaction($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: {subjectId: $subjectId, content: $content}) {
    reaction { databaseId }
  }
}`;

/** Return the GraphQL reaction for one feedback state. */
export function pullRequestReviewReactionContent(
  status: FeedbackStatus,
): (typeof STATUS_TO_GRAPHQL_REACTION)[FeedbackStatus] {
  return STATUS_TO_GRAPHQL_REACTION[status];
}

const reviewSchema = z.object({ node_id: z.string().min(1) });

const reviewReactionsSchema = z.object({
  data: z.object({
    node: z.object({
      reactionGroups: z.array(
        z.object({ content: z.string(), viewerHasReacted: z.boolean() }),
      ),
    }),
  }),
});

const addReviewReactionSchema = z.object({
  data: z.object({
    addReaction: z.object({
      reaction: z.object({ databaseId: z.number() }),
    }),
  }),
});

/** Send one GraphQL request and fail on HTTP or GraphQL errors. */
async function githubGraphql(
  egress: PluginEgress,
  input: {
    operation: string;
    operationName: string;
    query: string;
    variables: Record<string, unknown>;
  },
): Promise<unknown> {
  const response = await githubApi(egress, {
    operation: input.operation,
    method: "POST",
    path: "/graphql",
    body: {
      operationName: input.operationName,
      query: input.query,
      variables: input.variables,
    },
  });
  const errors = (response.body as { errors?: unknown } | undefined)?.errors;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
    throw new Error(
      `GitHub ${input.operationName} failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`,
    );
  }
  return response.body;
}

/**
 * Set Junior's feedback reaction on a review body. The viewer is the App
 * bot, so `viewerHasReacted` finds the state reactions that Junior owns.
 */
async function setReviewBodyFeedback(
  egress: PluginEgress,
  input: {
    owner: string;
    name: string;
    pullRequest: number;
    reviewId: number;
    status: FeedbackOutcome;
  },
): Promise<number | undefined> {
  const reviewResponse = await githubApi(egress, {
    operation: "github.pull.review.get",
    path: pullRequestReviewPath(input),
  });
  if (!reviewResponse.ok) {
    const message = `GitHub review lookup failed with HTTP ${reviewResponse.status}: ${githubErrorMessage(reviewResponse.body)}`;
    if (reviewResponse.status === 404) throw new PluginToolInputError(message);
    throw new Error(message);
  }
  const subjectId = reviewSchema.parse(reviewResponse.body).node_id;
  const repository = `${input.owner}/${input.name}`.toLowerCase();
  const target = pullRequestReviewReactionContent(input.status);
  const owned = new Set<string>(Object.values(STATUS_TO_GRAPHQL_REACTION));

  const reactions = reviewReactionsSchema.parse(
    await githubGraphql(egress, {
      operation: "github.pull.review-reaction.list",
      operationName: "ReviewReactions",
      query: `query ReviewReactions($subjectId: ID!) {
        node(id: $subjectId) {
          ... on PullRequestReview { reactionGroups { content viewerHasReacted } }
        }
      }`,
      variables: { subjectId },
    }),
  ).data.node.reactionGroups;
  for (const group of reactions) {
    if (!group.viewerHasReacted || group.content === target) continue;
    // Leave reactions that are not feedback states, such as a heart.
    if (!owned.has(group.content)) continue;
    await githubGraphql(egress, {
      operation: `github.pull.review-reaction.update:${repository}`,
      operationName: "RemoveReviewReaction",
      query: `mutation RemoveReviewReaction($subjectId: ID!, $content: ReactionContent!) {
        removeReaction(input: {subjectId: $subjectId, content: $content}) {
          reaction { content }
        }
      }`,
      variables: { subjectId, content: group.content },
    });
  }
  if (
    reactions.some(
      (group) => group.content === target && group.viewerHasReacted,
    )
  ) {
    return undefined;
  }
  const added = addReviewReactionSchema.parse(
    await githubGraphql(egress, {
      operation: `github.pull.review-reaction.update:${repository}`,
      operationName: "AddReviewReaction",
      query: ADD_REVIEW_REACTION_MUTATION,
      variables: { subjectId, content: target },
    }),
  );
  return added.data.addReaction.reaction.databaseId;
}

/**
 * Set Junior's feedback reaction on a pull request comment or review body.
 * Replace only state reactions Junior previously added to the same comment.
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
      "Set your outcome reaction on GitHub pull request feedback: addressed (+1) or declined (-1). Use the pull_request, comment_id, and comment_kind from the event after acting on the feedback. Replaces only your prior status reaction on that comment. Only works on pull requests the bot authored.",
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
        pull_request: pullRequest,
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
        number: pullRequest,
        botUserId,
      });
      if (commentKind === "review_body") {
        const reactionId = await setReviewBodyFeedback(ctx.egress, {
          owner: repo.owner,
          name: repo.name,
          pullRequest,
          reviewId: commentId,
          status,
        });
        return {
          target: "updatePullRequestFeedback",
          repo: repo.ref,
          comment_id: commentId,
          status,
          ...(reactionId !== undefined
            ? { reaction_id: reactionId }
            : undefined),
        };
      }
      const parentNumber = await commentParentNumber(ctx.egress, {
        owner: repo.owner,
        name: repo.name,
        commentKind,
        commentId,
      });
      if (parentNumber !== String(pullRequest)) {
        throw new PluginToolInputError(
          `GitHub comment ${commentId} is not on pull request ${pullRequest}.`,
        );
      }
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
