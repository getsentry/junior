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

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    comment_id: z
      .number()
      .int()
      .positive()
      .describe("Issue comment id, as returned by github_commentOnIssue."),
    body: z.string().trim().min(1).describe("Replacement comment text."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("updateIssueComment"),
  repo: z.string(),
  comment_id: z.number(),
  url: z.string(),
});
interface Result extends PluginToolOutput {
  target: "updateIssueComment";
  repo: string;
  comment_id: number;
  url: string;
}

/**
 * Replace the body of an issue or pull request conversation comment that the
 * App bot posted. Comments by other users are refused before the write.
 */
export function createGitHubUpdateIssueCommentTool(
  botEmail: string | undefined,
) {
  return definePluginTool({
    permission: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Replace the text of a GitHub issue or pull request conversation comment that you posted, for example to update a progress comment. Only works on your own comments.",
    inputSchema,
    outputSchema,
    async execute(
      input,
      _options,
      { egress }: { egress: PluginEgress },
    ): Promise<Result> {
      const repo = parseRepo(input.repo);
      const botUserId = botUserIdFromEmail(botEmail);
      if (botUserId === undefined) {
        throw new Error("GitHub App bot identity is not configured.");
      }
      const path = `${repoPath(repo)}/issues/comments/${input.comment_id}`;
      const lookup = await githubApi(egress, {
        operation: "github.issue.comment.get",
        path,
      });
      if (!lookup.ok) {
        const message = `GitHub issue comment lookup failed with HTTP ${lookup.status}: ${githubErrorMessage(lookup.body)}`;
        if (lookup.status === 404) throw new PluginToolInputError(message);
        throw new Error(message);
      }
      const author = z
        .object({ user: z.object({ id: z.number() }).nullable() })
        .safeParse(lookup.body);
      if (!author.success || author.data.user?.id !== botUserId) {
        throw new PluginToolInputError(
          "This bot can only edit issue comments it posted.",
        );
      }

      const response = await githubApi(egress, {
        operation: "github.issue.comment.update",
        method: "PATCH",
        path,
        body: { body: input.body },
      });
      if (!response.ok) {
        const message = `GitHub issue comment update failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const comment = z
        .object({ id: z.number(), html_url: z.string() })
        .parse(response.body);
      return {
        target: "updateIssueComment",
        repo: repo.ref,
        comment_id: comment.id,
        url: comment.html_url,
      };
    },
  });
}
