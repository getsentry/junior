import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    body: z.string().trim().min(1).describe("Comment text."),
    in_reply_to: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Inline review comment id. Set it to reply in that comment's thread. Omit it to comment on the pull request.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("commentOnPullRequest"),
  repo: z.string(),
  number: z.number(),
  comment_id: z.number(),
  url: z.string(),
});
interface Result extends PluginToolOutput {
  target: "commentOnPullRequest";
  repo: string;
  number: number;
  comment_id: number;
  url: string;
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
    if (response.status === 404) throw new PluginToolInputError(message);
    throw new Error(message);
  }
  const comment = z
    .object({ in_reply_to_id: z.number().nullish() })
    .parse(response.body);
  return comment.in_reply_to_id ?? commentId;
}

/**
 * Post a pull request comment as the App bot, or reply in an inline review
 * thread. GitHub keeps conversation comments under the issues endpoint and
 * thread replies under the pulls endpoint.
 */
export function createGitHubCommentOnPullRequestTool(egress: PluginEgress) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Post a conversation comment on a GitHub pull request, or reply in an inline review thread with in_reply_to. For issues, use github_commentOnIssue. Use it to answer a question asked in a pull request review or comment. Returns the comment id and URL.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const prefix = repoPath(repo);
      const path =
        input.in_reply_to === undefined
          ? `${prefix}/issues/${input.number}/comments`
          : `${prefix}/pulls/${input.number}/comments/${await threadRootId(egress, prefix, input.in_reply_to)}/replies`;
      const response = await githubApi(egress, {
        operation: "github.pull.comment.create",
        method: "POST",
        path,
        body: { body: input.body },
      });
      if (!response.ok) {
        const message = `GitHub pull request comment failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const comment = z
        .object({ id: z.number(), html_url: z.string() })
        .parse(response.body);
      return {
        target: "commentOnPullRequest",
        repo: repo.ref,
        number: input.number,
        comment_id: comment.id,
        reply: { text: input.body, url: comment.html_url },
        url: comment.html_url,
      };
    },
  });
}
