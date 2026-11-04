import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

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

function githubError(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return "GitHub request failed";
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
      "Post a comment on a GitHub pull request, or reply in an inline review thread with in_reply_to. Use it to answer a question asked in a pull request review or comment. Returns the comment id and URL.",
    exposure: "direct",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const repoPath = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
      const url =
        input.in_reply_to === undefined
          ? `${repoPath}/issues/${input.number}/comments`
          : `${repoPath}/pulls/${input.number}/comments/${input.in_reply_to}/replies`;
      const response = await egress.fetch({
        provider: "github",
        operation: "github.pull.comment.create",
        request: new Request(url, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ body: input.body }),
        }),
      });
      const parsed = await readJson(response);
      if (!response.ok) {
        const message = `GitHub pull request comment failed with HTTP ${response.status}: ${githubError(parsed)}`;
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const comment = z
        .object({ id: z.number(), html_url: z.string() })
        .parse(parsed);
      return {
        target: "commentOnPullRequest",
        repo: repo.ref,
        number: input.number,
        comment_id: comment.id,
        url: comment.html_url,
      };
    },
  });
}
