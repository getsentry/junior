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
  type GitHubApiResponse,
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

// A review body has no REST reactions endpoint, so it uses GraphQL, which
// names the same reactions differently.
const GRAPHQL_REACTION_CONTENT: Record<string, string> = {
  eyes: "EYES",
  "+1": "THUMBS_UP",
  "-1": "THUMBS_DOWN",
};
const REST_REACTION_CONTENT = new Map(
  Object.entries(GRAPHQL_REACTION_CONTENT).map(([rest, graphql]) => [
    graphql,
    rest,
  ]),
);

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
});
interface Result extends PluginToolOutput {
  target: "updatePullRequestFeedback";
  repo: string;
  comment_id: number;
  status: FeedbackOutcome;
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

/** Return the GraphQL name of one REST reaction content. */
export function graphqlReactionContent(content: string): string {
  return GRAPHQL_REACTION_CONTENT[content] ?? content;
}

/** The GraphQL mutation that adds one reaction to a review body. */
export const ADD_REVIEW_REACTION_MUTATION = `mutation AddReviewReaction($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: {subjectId: $subjectId, content: $content}) {
    reaction { content }
  }
}`;

const REMOVE_REVIEW_REACTION_MUTATION = `mutation RemoveReviewReaction($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: {subjectId: $subjectId, content: $content}) {
    reaction { content }
  }
}`;

const REVIEW_REACTIONS_QUERY = `query ReviewReactions($subjectId: ID!) {
  node(id: $subjectId) {
    ... on PullRequestReview {
      reactionGroups {
        content
        reactors(first: 100) { nodes { ... on Bot { databaseId } } }
      }
    }
  }
}`;

const reviewReactionsSchema = z.object({
  data: z.object({
    node: z.object({
      reactionGroups: z.array(
        z.object({
          content: z.string(),
          reactors: z.object({
            nodes: z.array(z.object({ databaseId: z.number().optional() })),
          }),
        }),
      ),
    }),
  }),
});

/** One reaction by the bot. REST reactions have an id; GraphQL ones do not. */
interface BotReaction {
  content: string;
  id?: number;
}

/**
 * The reactions on one pull request comment or review body. Each kind has its
 * own GitHub API, but the feedback rules are the same for both.
 */
interface FeedbackReactions {
  list(): Promise<GitHubApiResponse>;
  botReactions(body: unknown): BotReaction[];
  remove(reaction: BotReaction): Promise<GitHubApiResponse>;
  add(content: string): Promise<GitHubApiResponse>;
}

/** Return the REST reactions of a comment that is on `pullRequest`. */
async function commentReactions(
  egress: PluginEgress,
  input: PullRequestCommentRef & { botUserId: number; pullRequest: number },
): Promise<FeedbackReactions> {
  const parentNumber = await commentParentNumber(egress, input);
  if (parentNumber !== String(input.pullRequest)) {
    throw new PluginToolInputError(
      `GitHub comment ${input.commentId} is not on pull request ${input.pullRequest}.`,
    );
  }
  const path = pullRequestCommentReactionsPath(input);
  return {
    list: () =>
      githubApi(egress, {
        operation: "github.pull.comment-reaction.list",
        path: `${path}?per_page=100`,
      }),
    botReactions: (body) =>
      z
        .array(reactionSchema)
        .parse(body)
        .filter((reaction) => reaction.user?.id === input.botUserId),
    remove: (reaction) =>
      githubApi(egress, {
        operation: "github.pull.comment-reaction.delete",
        method: "DELETE",
        path: `${path}/${reaction.id}`,
      }),
    add: (content) =>
      githubApi(egress, {
        operation: "github.pull.comment-reaction.create",
        method: "POST",
        path,
        body: { content },
      }),
  };
}

/** Return the GraphQL reactions of a review on `pullRequest`. */
async function reviewBodyReactions(
  egress: PluginEgress,
  input: {
    botUserId: number;
    name: string;
    owner: string;
    pullRequest: number;
    reviewId: number;
  },
): Promise<FeedbackReactions> {
  // The path names the pull request, so GitHub returns 404 for a review on
  // another pull request.
  const reviewResponse = await githubApi(egress, {
    operation: "github.pull.review.get",
    path: pullRequestReviewPath(input),
  });
  if (!reviewResponse.ok) {
    const message = `GitHub review lookup failed with HTTP ${reviewResponse.status}: ${githubErrorMessage(reviewResponse.body)}`;
    if (reviewResponse.status === 404) throw new PluginToolInputError(message);
    throw new Error(message);
  }
  const subjectId = z
    .object({ node_id: z.string().min(1) })
    .parse(reviewResponse.body).node_id;
  const graphql = (
    operation: string,
    operationName: string,
    query: string,
    variables: Record<string, string>,
  ) =>
    githubApi(egress, {
      operation,
      method: "POST",
      path: "/graphql",
      body: { operationName, query, variables },
    });
  const update =
    `github.pull.review-reaction.update:${input.owner}/${input.name}`.toLowerCase();
  return {
    list: () =>
      graphql(
        "github.pull.review-reaction.list",
        "ReviewReactions",
        REVIEW_REACTIONS_QUERY,
        { subjectId },
      ),
    botReactions: (body) =>
      reviewReactionsSchema
        .parse(body)
        .data.node.reactionGroups.filter((group) =>
          group.reactors.nodes.some(
            (reactor) => reactor.databaseId === input.botUserId,
          ),
        )
        .map((group) => ({
          content: REST_REACTION_CONTENT.get(group.content) ?? group.content,
        })),
    remove: (reaction) =>
      graphql(update, "RemoveReviewReaction", REMOVE_REVIEW_REACTION_MUTATION, {
        subjectId,
        content: graphqlReactionContent(reaction.content),
      }),
    add: (content) =>
      graphql(update, "AddReviewReaction", ADD_REVIEW_REACTION_MUTATION, {
        subjectId,
        content: graphqlReactionContent(content),
      }),
  };
}

// GraphQL reports errors with HTTP 200, so a failed reply can be `ok`.
function failed(response: GitHubApiResponse): boolean {
  const errors = (response.body as { errors?: unknown } | null | undefined)
    ?.errors;
  return !response.ok || (Array.isArray(errors) && errors.length > 0);
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
      const reactions =
        commentKind === "review_body"
          ? await reviewBodyReactions(ctx.egress, {
              owner: repo.owner,
              name: repo.name,
              pullRequest,
              reviewId: commentId,
              botUserId,
            })
          : await commentReactions(ctx.egress, {
              owner: repo.owner,
              name: repo.name,
              commentKind,
              commentId,
              pullRequest,
              botUserId,
            });
      const targetContent = pullRequestFeedbackReactionContent(status);

      const listResponse = await reactions.list();
      const listPayload = listResponse.body;
      if (failed(listResponse)) {
        throw new Error(
          `GitHub reaction lookup failed with HTTP ${listResponse.status}: ${githubErrorMessage(listPayload)}`,
        );
      }
      const botReactions = reactions
        .botReactions(listPayload)
        .filter((reaction) => FEEDBACK_REACTION_CONTENTS.has(reaction.content));

      for (const stale of botReactions) {
        if (stale.content === targetContent) continue;
        const deleteResponse = await reactions.remove(stale);
        if (failed(deleteResponse) && deleteResponse.status !== 404) {
          throw new Error(
            `GitHub reaction removal failed with HTTP ${deleteResponse.status}: ${githubErrorMessage(deleteResponse.body)}`,
          );
        }
      }

      if (
        !botReactions.some((reaction) => reaction.content === targetContent)
      ) {
        const createResponse = await reactions.add(targetContent);
        const createPayload = createResponse.body;
        if (failed(createResponse)) {
          throw new Error(
            `GitHub reaction creation failed with HTTP ${createResponse.status}: ${githubErrorMessage(createPayload)}`,
          );
        }
      }
      return {
        target: "updatePullRequestFeedback",
        repo: repo.ref,
        comment_id: commentId,
        status,
      };
    },
  });
}
