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
const reviewCommentSchema = z
  .object({
    path: z.string().trim().min(1).describe("File path in the pull request."),
    body: z.string().trim().min(1).describe("Inline review comment."),
    line: z
      .number()
      .int()
      .positive()
      .describe("Line in the pull request diff."),
    side: z.enum(["LEFT", "RIGHT"]).describe("Side of the pull request diff."),
    start_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line of a multi-line comment."),
    start_side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .describe("First side of a multi-line comment."),
  })
  .strict()
  .refine(
    ({ start_line, start_side }) =>
      (start_line === undefined) === (start_side === undefined),
    { message: "start_line and start_side must be provided together." },
  );

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    event: z
      .enum(["COMMENT", "REQUEST_CHANGES"])
      .describe("Review result. You cannot approve pull requests."),
    body: z.string().trim().min(1).describe("Review summary."),
    comments: z
      .array(reviewCommentSchema)
      .optional()
      .describe("Optional inline review comments."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("submitPullRequestReview"),
  repo: z.string(),
  number: z.number(),
  review_id: z.number(),
  state: z.string(),
  url: z.string(),
});
interface Result extends PluginToolOutput {
  target: "submitPullRequestReview";
  repo: string;
  number: number;
  review_id: number;
  state: string;
  url: string;
}

function throwReviewError(status: number, body: unknown): never {
  const message = `GitHub pull request review failed with HTTP ${status}: ${githubErrorMessage(body)}`;
  if (status === 404 || status === 422) {
    throw new PluginToolInputError(message);
  }
  throw new Error(message);
}

/** Submit a comment or change-request review through GitHub's REST API. */
export const gitHubSubmitPullRequestReviewTool = definePluginTool({
  permission: "review",
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Submit a GitHub pull request review as a comment or change request. Use this instead of `gh pr review`, GraphQL, or direct REST calls. You cannot approve pull requests.",
  inputSchema,
  outputSchema,
  async execute(
    review,
    _options,
    { egress }: { egress: PluginEgress },
  ): Promise<Result> {
    const repo = parseRepo(review.repo);
    const comments = review.comments?.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side,
      ...(comment.start_line !== undefined
        ? { start_line: comment.start_line }
        : undefined),
      ...(comment.start_side !== undefined
        ? { start_side: comment.start_side }
        : undefined),
    }));
    const response = await githubApi(egress, {
      operation: "github.pull.review.create",
      method: "POST",
      path: `${repoPath(repo)}/pulls/${review.number}/reviews`,
      body: {
        body: review.body,
        event: review.event,
        ...(comments ? { comments } : undefined),
      },
    });
    if (!response.ok) {
      throwReviewError(response.status, response.body);
    }
    const providerResult = z
      .object({ id: z.number(), html_url: z.string(), state: z.string() })
      .parse(response.body);
    return {
      target: "submitPullRequestReview",
      repo: repo.ref,
      number: review.number,
      reply: { text: review.body, url: providerResult.html_url },
      review_id: providerResult.id,
      state: providerResult.state,
      url: providerResult.html_url,
    };
  },
});
