import {
  type PluginEgress,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubDbSchema } from "../db/database.js";
import { pullRequestTarget } from "../tool-support/pull-request-target.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { markGitHubReviewAsked } from "../pull-request-review-again.js";
import {
  linkedGitHubLogin,
  requesterPerson,
} from "../tool-support/attribution.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    pull_request: z.number().int().positive().describe("Pull request number."),
    body: z.string().trim().min(1).describe("Comment text."),
    in_reply_to: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Inline review comment id. Set it to reply in that comment's thread. Omit it to comment on the pull request.",
      ),
    asks_requester: z
      .boolean()
      .optional()
      .describe(
        "True when the comment asks the person who asked for this pull request to answer or decide. Also asks them for a review on GitHub, so the pull request waits on them in their Inbox. Omit it otherwise.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("commentOnPullRequest"),
  repo: z.string(),
  number: z.number(),
  comment_id: z.number(),
  url: z.string(),
  requester_asked: z.boolean().optional(),
});
interface Result extends PluginToolOutput {
  target: "commentOnPullRequest";
  repo: string;
  number: number;
  comment_id: number;
  url: string;
  /**
   * Set when the comment asks the requester. False when Junior did not open
   * the pull request for the person this Turn works for, that person has no
   * linked GitHub account, or GitHub did not take the review request.
   */
  requester_asked?: boolean;
}

/**
 * Return the id of the first comment in the review thread of `commentId`.
 * GitHub accepts replies only to that comment, but Events can name a reply.
 */
async function threadRootId(
  egress: PluginEgress,
  prefix: string,
  commentId: number,
): Promise<number> {
  const response = await githubApi(egress, {
    operation: "github.pull.comment.get",
    path: `${prefix}/pulls/comments/${commentId}`,
  });
  if (!response.ok) {
    const message = `GitHub review comment lookup failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
    if (response.status === 404) {
      throw new PluginToolInputError(
        `${message}. Set in_reply_to to the id of a review comment in repo.`,
      );
    }
    throw new Error(message);
  }
  const comment = z
    .object({ in_reply_to_id: z.number().nullish() })
    .parse(response.body);
  return comment.in_reply_to_id ?? commentId;
}

type CommentContext = Pick<
  ToolRegistrationHookContext,
  "db" | "egress" | "log" | "resolveWorkOwner" | "state"
>;

/**
 * Ask the person who asked Junior for the pull request to review it on
 * GitHub, and return whether GitHub took the request. The review request
 * makes the pull request's next action "review" (`pull-request-action.ts`),
 * so its one Inbox item waits on them, and GitHub notifies them. The comment
 * is already posted, so a failure is logged and returned, not thrown.
 */
async function askRequester(
  ctx: CommentContext,
  target: { number: number; prefix: string; repo: string },
): Promise<boolean> {
  const fields = { number: target.number, repo: target.repo };
  try {
    const [opener, owner] = await Promise.all([
      listGitHubPullRequestOpeners(gitHubDbSchema.parse(ctx.db), {
        numbers: [target.number],
        repositoryFullName: target.repo,
      }).then((openers) => openers.get(target.number)),
      ctx.resolveWorkOwner().then(requesterPerson),
    ]);
    // Only the opener row of a pull request that Junior opened has a
    // Conversation, which is where its Inbox item goes. Only that person, in
    // their own work, is asked.
    const login =
      opener?.conversationId && owner?.identity?.id === opener.identityId
        ? linkedGitHubLogin(owner.user)
        : undefined;
    if (!login) return false;
    // GitHub's review request webhook shows the item. This mark gives it the
    // text that says Junior asked a question.
    await markGitHubReviewAsked(
      ctx.state,
      { number: target.number, repositoryFullName: target.repo },
      { at: new Date().toISOString(), reason: "question", reviewer: login },
    );
    const path = `${target.prefix}/pulls/${target.number}/requested_reviewers`;
    // GitHub records no new review request for a reviewer that it already
    // asks, so their last reply would still count after the question.
    // Removing the request first makes GitHub ask again.
    const removed =
      (await isRequested(ctx, path, login)) &&
      (
        await githubApi(ctx.egress, {
          operation: "github.pull.request_reviewers",
          method: "DELETE",
          path,
          body: { reviewers: [login] },
        })
      ).ok;
    let response = await requestReviewer(ctx, path, login);
    // A failed request after the removal would leave the requester unasked,
    // though GitHub asked them before. A transient failure gets one more try.
    if (removed && isTransient(response.status)) {
      response = await requestReviewer(ctx, path, login);
    }
    if (response.ok) return true;
    ctx.log.warn(
      "github.pull_request.request_reviewers_after_question.rejected",
      { ...fields, status: response.status },
    );
  } catch (error) {
    ctx.log.warn(
      "github.pull_request.request_reviewers_after_question.failed",
      {
        ...fields,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
    );
  }
  return false;
}

function requestReviewer(ctx: CommentContext, path: string, login: string) {
  return githubApi(ctx.egress, {
    operation: "github.pull.request_reviewers",
    method: "POST",
    path,
    body: { reviewers: [login] },
  });
}

// GitHub's rate limit and server errors can pass on a second try.
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Whether GitHub asks `login` for a review of the pull request now. */
async function isRequested(
  ctx: CommentContext,
  path: string,
  login: string,
): Promise<boolean> {
  const response = await githubApi(ctx.egress, {
    operation: "github.pull.request_reviewers",
    method: "GET",
    path,
  });
  if (!response.ok) return false;
  const parsed = z
    .object({ users: z.array(z.object({ login: z.string() })) })
    .safeParse(response.body);
  const lower = login.toLowerCase();
  return (
    parsed.success &&
    parsed.data.users.some((user) => user.login.toLowerCase() === lower)
  );
}

/**
 * Post a pull request comment as the App bot, or reply in an inline review
 * thread. GitHub keeps conversation comments under the issues endpoint and
 * thread replies under the pulls endpoint.
 */
export const gitHubCommentOnPullRequestTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Post a conversation comment on a GitHub pull request, or reply in an inline review thread. For issues, use github_commentOnIssue. Use it to answer a question asked in a pull request review or comment. Returns the comment id and URL, and whether the requester was asked.",
  guardian: {
    async describe(input) {
      const target = pullRequestTarget(input.repo, input.pull_request);
      // A comment or a reply on the pull request edits its content.
      return {
        effect: "edit",
        ...(target ? { target } : undefined),
        summary: `Comment on pull request ${target?.ref ?? input.pull_request}.`,
      };
    },
  },
  inputSchema,
  outputSchema,
  async execute(input, _options, ctx: CommentContext): Promise<Result> {
    const { egress } = ctx;
    const repo = parseRepo(input.repo);
    const prefix = repoPath(repo);
    const path =
      input.in_reply_to === undefined
        ? `${prefix}/issues/${input.pull_request}/comments`
        : `${prefix}/pulls/${input.pull_request}/comments/${await threadRootId(egress, prefix, input.in_reply_to)}/replies`;
    const response = await githubApi(egress, {
      operation: "github.pull.comment.create",
      method: "POST",
      path,
      body: { body: input.body },
    });
    if (!response.ok) {
      const message = `GitHub pull request comment failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
      if (response.status === 404 || response.status === 422) {
        throw new PluginToolInputError(
          `${message}. Check repo and pull_request, and fix any field that GitHub names.`,
        );
      }
      throw new Error(message);
    }
    const comment = z
      .object({ id: z.number(), html_url: z.string() })
      .parse(response.body);
    return {
      target: "commentOnPullRequest",
      repo: repo.ref,
      number: input.pull_request,
      comment_id: comment.id,
      reply: { text: input.body, url: comment.html_url },
      url: comment.html_url,
      ...(input.asks_requester
        ? {
            requester_asked: await askRequester(ctx, {
              number: input.pull_request,
              prefix,
              repo: repo.ref,
            }),
          }
        : undefined),
    };
  },
});
