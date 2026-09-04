import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
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
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line of a multi-line comment."),
    startSide: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .describe("First side of a multi-line comment."),
  })
  .strict()
  .refine(
    ({ startLine, startSide }) =>
      (startLine === undefined) === (startSide === undefined),
    { message: "startLine and startSide must be provided together." },
  );

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    event: z
      .enum(["COMMENT", "REQUEST_CHANGES"])
      .describe("Review result. Junior cannot approve pull requests."),
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
  reviewId: z.number(),
  state: z.string(),
  url: z.string(),
});
interface Result extends PluginToolOutput {
  target: "submitPullRequestReview";
  repo: string;
  number: number;
  reviewId: number;
  state: string;
  url: string;
}

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
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
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return "GitHub request failed";
}

/** Submit a comment or change-request review through GitHub's REST API. */
export function createGitHubSubmitPullRequestReviewTool(ctx: {
  egress: PluginEgress;
}) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Submit a GitHub pull request review as COMMENT or REQUEST_CHANGES. Use this instead of `gh pr review`, GraphQL, or raw REST. Junior cannot approve pull requests.",
    exposure: "direct",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub submitPullRequestReview input.",
          { cause: parsedInput.error },
        );
      }
      const review = parsedInput.data;
      const repo = parseRepo(review.repo);
      const comments = review.comments?.map((comment) => ({
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side: comment.side,
        ...(comment.startLine !== undefined
          ? { start_line: comment.startLine }
          : undefined),
        ...(comment.startSide !== undefined
          ? { start_side: comment.startSide }
          : undefined),
      }));
      const response = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.review.create",
        request: new Request(
          `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${review.number}/reviews`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
              body: review.body,
              event: review.event,
              ...(comments ? { comments } : undefined),
            }),
          },
        ),
      });
      const parsed = await readJson(response);
      if (!response.ok) {
        throw new Error(
          `GitHub pull request review failed with HTTP ${response.status}: ${githubError(parsed)}`,
        );
      }
      const providerResult = z
        .object({ id: z.number(), html_url: z.string(), state: z.string() })
        .parse(parsed);
      return {
        target: "submitPullRequestReview",
        repo: repo.ref,
        number: review.number,
        reviewId: providerResult.id,
        state: providerResult.state,
        url: providerResult.html_url,
      };
    },
  });
}
