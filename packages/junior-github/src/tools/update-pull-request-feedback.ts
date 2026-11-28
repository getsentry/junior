import pLimit from "p-limit";
import {
  type PluginEgress,
  type PluginLogger,
  type PluginState,
  type PluginToolOutput,
  type PluginWorkOwner,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubDbSchema } from "../db/database.js";
import { repositoryCall } from "../tool-support/guardian-call.js";
import {
  ADD_REVIEW_REACTION,
  type GitHubGraphqlOperation,
  REMOVE_REVIEW_REACTION,
  REVIEW_REACTIONS,
} from "../graphql-documents.js";
import {
  FEEDBACK_REACTION_CONTENTS,
  type FeedbackStatus,
  graphqlReactionContent,
  type PullRequestCommentRef,
  pullRequestCommentPath,
  pullRequestCommentReactionsPath,
  pullRequestFeedbackReactionContent,
  pullRequestReviewPath,
  REST_REACTION_CONTENT,
} from "../pull-request-feedback.js";
import {
  dropHeldGitHubReviewAsk,
  holdGitHubReviewAsk,
  markGitHubReviewAsked,
  readReviewAgainReadiness,
} from "../pull-request-review-again.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import {
  linkedGitHubLogin,
  requesterPerson,
} from "../tool-support/attribution.js";
import { botUserIdFromEmail } from "../webhooks/ownership.js";
import {
  type GitHubApiResponse,
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    comment_kind: z
      .enum(["conversation", "review", "review_body"])
      .describe(
        'Comment kind: "conversation" for a pull request conversation comment, "review" for an inline review comment, "review_body" for the body of a submitted review. Use the exact value from the event.',
      ),
    comment_id: z
      .number()
      .int()
      .positive()
      .describe(
        "GitHub comment id (conversation comment id, inline review comment id, or review id). Use the exact value from the event.",
      ),
    pull_request: z
      .number()
      .int()
      .positive()
      .describe(
        "Pull request number that the comment is on. Use the exact value from the event.",
      ),
    status: z
      .enum(["addressed", "declined"])
      .describe(
        'Feedback outcome. "addressed" (+1): you made the change, answered it, or agree and wait on the reviewer to confirm or choose. "declined" (-1), which reviewers read as disagreement: you push back or defer the change to later work.',
      ),
  })
  .strict();

type FeedbackOutcome = Exclude<FeedbackStatus, "reviewing">;

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

const reactionSchema = z.object({
  id: z.number(),
  content: z.string(),
  user: z.object({ id: z.number() }).nullable(),
});

/**
 * Return the issue or pull request number of one comment in `repo`, and its
 * author. A conversation comment is an issue comment, so its issue can be a
 * plain issue.
 */
async function readComment(
  egress: PluginEgress,
  input: PullRequestCommentRef,
): Promise<{ author?: string; number: string }> {
  const commentResponse = await githubApi(egress, {
    operation: "github.pull.comment.get",
    path: pullRequestCommentPath(input),
  });
  const commentPayload = commentResponse.body;
  if (!commentResponse.ok) {
    const message = `GitHub comment lookup failed with HTTP ${commentResponse.status}: ${githubErrorMessage(commentPayload)}`;
    if (commentResponse.status === 404) {
      throw new PluginToolInputError(
        `${message}. Check repo, comment_id, and comment_kind.`,
      );
    }
    throw new Error(message);
  }
  const comment = z
    .object({
      issue_url: z.string().optional(),
      pull_request_url: z.string().optional(),
      user: z
        .object({ login: z.string().min(1) })
        .nullable()
        .optional(),
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
  const author = comment.success ? comment.data.user?.login : undefined;
  return { ...(author ? { author } : undefined), number };
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
      "This bot can only set feedback status on comments on pull requests it authored. Do not call this tool for this pull request.",
    );
  }
}

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
 * The reactions on one pull request comment or review body, and its author.
 * Each kind has its own GitHub API, but the feedback rules are the same for
 * both.
 */
interface FeedbackReactions {
  author?: string;
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
  const comment = await readComment(egress, input);
  if (comment.number !== String(input.pullRequest)) {
    throw new PluginToolInputError(
      `GitHub comment ${input.commentId} is not on pull request ${input.pullRequest}. Set pull_request to the pull request that has the comment.`,
    );
  }
  const path = pullRequestCommentReactionsPath(input);
  return {
    ...(comment.author ? { author: comment.author } : undefined),
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
    if (reviewResponse.status === 404) {
      throw new PluginToolInputError(
        `${message}. Check repo, pull_request, and comment_id.`,
      );
    }
    throw new Error(message);
  }
  const review = z
    .object({
      node_id: z.string().min(1),
      user: z
        .object({ login: z.string().min(1) })
        .nullable()
        .optional(),
    })
    .parse(reviewResponse.body);
  const subjectId = review.node_id;
  const graphql = (
    operation: string,
    document: GitHubGraphqlOperation,
    variables: Record<string, string>,
  ) =>
    githubApi(egress, {
      operation,
      method: "POST",
      path: "/graphql",
      body: { ...document, variables },
    });
  const update =
    `github.pull.review-reaction.update:${input.owner}/${input.name}`.toLowerCase();
  return {
    ...(review.user ? { author: review.user.login } : undefined),
    list: () =>
      graphql("github.pull.review-reaction.list", REVIEW_REACTIONS, {
        subjectId,
      }),
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
      graphql(update, REMOVE_REVIEW_REACTION, {
        subjectId,
        content: graphqlReactionContent(reaction.content),
      }),
    add: (content) =>
      graphql(update, ADD_REVIEW_REACTION, {
        subjectId,
        content: graphqlReactionContent(content),
      }),
  };
}

/** What the feedback tool reads and changes. */
interface FeedbackContext {
  db: unknown;
  egress: PluginEgress;
  log: Pick<PluginLogger, "warn">;
  resolveWorkOwner(): Promise<PluginWorkOwner | undefined>;
  state: PluginState;
}

/**
 * Whether `reviewer` is the person who asked Junior for the pull request.
 * Only the opener row of a pull request that Junior opened has a
 * Conversation, and only that person's own work knows their linked GitHub
 * login, as when Junior asks them a question.
 */
async function reviewerIsRequester(
  ctx: Pick<FeedbackContext, "db" | "resolveWorkOwner">,
  input: { name: string; owner: string; pullRequest: number; reviewer: string },
): Promise<boolean> {
  const [opener, owner] = await Promise.all([
    listGitHubPullRequestOpeners(gitHubDbSchema.parse(ctx.db), {
      numbers: [input.pullRequest],
      repositoryFullName: `${input.owner}/${input.name}`,
    }).then((openers) => openers.get(input.pullRequest)),
    ctx.resolveWorkOwner().then(requesterPerson),
  ]);
  const login =
    opener?.conversationId && owner?.identity?.id === opener.identityId
      ? linkedGitHubLogin(owner.user)
      : undefined;
  return login?.toLowerCase() === input.reviewer.toLowerCase();
}

/**
 * Ask the reviewer to review again when every comment of their latest
 * change request is marked and the required checks pass. For the requester,
 * their comment-only reviews count as a change request. GitHub stops
 * asking a reviewer once they review, so the fixed pull request would not
 * wait on them. While the checks have not passed, the ask is held, and the
 * check suite webhook asks when they pass. The ask is optional, so a failure
 * is logged and does not fail the tool.
 */
async function askForReviewAgain(
  ctx: FeedbackContext,
  input: {
    botUserId: number;
    marked?: { id: number; kind: "review" | "review_body" };
    name: string;
    owner: string;
    pullRequest: number;
    reviewer: string;
  },
): Promise<void> {
  const target = {
    number: input.pullRequest,
    repositoryFullName: `${input.owner}/${input.name}`,
  };
  const fields = { number: target.number, repo: target.repositoryFullName };
  try {
    const readiness = await readReviewAgainReadiness(
      async (request) => {
        const response = await githubApi(ctx.egress, {
          ...request,
          ...(request.body === undefined ? undefined : { method: "POST" }),
        });
        // GraphQL can return partial data with errors, such as for a
        // field the token cannot read, so only the schema rejects it.
        if (!response.ok) {
          throw new Error(
            `GitHub ${request.operation} failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`,
          );
        }
        return response.body;
      },
      {
        ...input,
        isRequester: async () => await reviewerIsRequester(ctx, input),
        number: input.pullRequest,
      },
    );
    // A read can lag behind another comment's new mark, so "none" drops
    // nothing. Each webhook checks a held ask again.
    if (readiness === "none") return;
    const at = new Date().toISOString();
    if (readiness === "checks") {
      await holdGitHubReviewAsk(ctx.state, target, {
        at,
        ...(input.marked ? { marked: input.marked } : undefined),
        reason: "checks",
        reviewer: input.reviewer,
      });
      return;
    }
    // GitHub's review request webhook shows the item. This record gives it
    // the reason.
    await markGitHubReviewAsked(ctx.state, target, {
      at,
      reviewer: input.reviewer,
    });
    if (await requestReviewer(ctx, input)) {
      await dropHeldGitHubReviewAsk(ctx.state, target, input.reviewer);
      return;
    }
    // The next webhook asks again.
    await holdGitHubReviewAsk(ctx.state, target, {
      at,
      ...(input.marked ? { marked: input.marked } : undefined),
      reason: "handled",
      reviewer: input.reviewer,
    });
  } catch (error) {
    ctx.log.warn(
      "github.pull_request.request_reviewers_after_feedback.failed",
      {
        ...fields,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
    );
  }
}

/** Ask the reviewer on GitHub, and return whether GitHub took the request. */
async function requestReviewer(
  ctx: { egress: PluginEgress; log: Pick<PluginLogger, "warn"> },
  input: { name: string; owner: string; pullRequest: number; reviewer: string },
): Promise<boolean> {
  const fields = {
    number: input.pullRequest,
    repo: `${input.owner}/${input.name}`,
  };
  try {
    const response = await githubApi(ctx.egress, {
      operation: "github.pull.request_reviewers",
      method: "POST",
      path: `${repoPath(input)}/pulls/${input.pullRequest}/requested_reviewers`,
      body: { reviewers: [input.reviewer] },
    });
    if (response.ok) return true;
    ctx.log.warn(
      "github.pull_request.request_reviewers_after_feedback.rejected",
      { ...fields, status: response.status },
    );
  } catch (error) {
    ctx.log.warn(
      "github.pull_request.request_reviewers_after_feedback.failed",
      {
        ...fields,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
    );
  }
  return false;
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
 * When the comments of a change request are all marked, ask its reviewer to
 * review again.
 */
export function createGitHubUpdatePullRequestFeedbackTool(
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
      "Set your outcome reaction on GitHub pull request feedback: addressed (+1) or declined (-1). Call it after you act on or reply to the feedback. Replaces only your prior status reaction on that comment. When every comment of the author's latest change request, or of the requester's latest comment-only reviews, is marked and the required checks pass, asks the author to review again. Only works on pull requests the bot authored.",
    exposure: "direct",
    // A status reaction can ask the author to review again, so it is not
    // just text.
    guardian: (input, ctx) =>
      repositoryCall(input.repo, ctx, input.pull_request),
    inputSchema,
    outputSchema,
    async execute(input, _options, ctx: FeedbackContext): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub updatePullRequestFeedback input. Check the arguments against the tool schema and call it again.",
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
      const reactions: FeedbackReactions =
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

      // Feedback reactions are a small fixed set, so remove them at once.
      const deleteResponses = await pLimit(FEEDBACK_REACTION_CONTENTS.size).map(
        botReactions.filter((stale) => stale.content !== targetContent),
        (stale) => reactions.remove(stale),
      );
      for (const deleteResponse of deleteResponses) {
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
      if (reactions.author) {
        await askForReviewAgain(ctx, {
          botUserId,
          name: repo.name,
          owner: repo.owner,
          ...(commentKind === "conversation"
            ? undefined
            : { marked: { id: commentId, kind: commentKind } }),
          pullRequest,
          reviewer: reactions.author,
        });
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
