import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { describeRepositoryCall } from "../tool-support/describe-call.js";
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
    issue: z.number().int().positive().describe("Issue number."),
    body: z.string().trim().min(1).describe("Comment text."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("commentOnIssue"),
  repo: z.string(),
  number: z.number(),
  comment_id: z.number(),
  url: z.string(),
});
interface Result extends PluginToolOutput {
  target: "commentOnIssue";
  repo: string;
  number: number;
  comment_id: number;
  url: string;
}

/** Post a comment on a GitHub issue as the App bot. */
export const gitHubCommentOnIssueTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Post a comment on a GitHub issue. Returns the comment id and URL.",
  inputSchema,
  describe: (input, ctx) =>
    describeRepositoryCall(input.repo, ctx, input.issue),
  outputSchema,
  async execute(
    input,
    _options,
    { egress }: { egress: PluginEgress },
  ): Promise<Result> {
    const repo = parseRepo(input.repo);
    const response = await githubApi(egress, {
      operation: "github.issue.comment.create",
      method: "POST",
      path: `${repoPath(repo)}/issues/${input.issue}/comments`,
      body: { body: input.body },
    });
    if (!response.ok) {
      const message = `GitHub issue comment failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
      if (response.status === 404 || response.status === 422) {
        throw new PluginToolInputError(
          `${message}. Check repo and issue, and fix any field that GitHub names.`,
        );
      }
      throw new Error(message);
    }
    const comment = z
      .object({ id: z.number(), html_url: z.string() })
      .parse(response.body);
    return {
      target: "commentOnIssue",
      repo: repo.ref,
      number: input.issue,
      comment_id: comment.id,
      url: comment.html_url,
    };
  },
});
