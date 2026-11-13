import {
  type PluginEgress,
  type PluginToolOutput,
  definePluginTool,
  pluginToolDefinition,
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

// GitHub's REST reaction contents.
const REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z
      .number()
      .int()
      .positive()
      .describe("Issue or pull request number."),
    content: z.enum(REACTION_CONTENTS).describe("Reaction to add."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("reactToIssue"),
  repo: z.string(),
  number: z.number(),
  content: z.enum(REACTION_CONTENTS),
  reaction_id: z.number(),
});
interface Result extends PluginToolOutput {
  target: "reactToIssue";
  repo: string;
  number: number;
  content: (typeof REACTION_CONTENTS)[number];
  reaction_id: number;
}

export const gitHubReactToIssueToolDefinition = pluginToolDefinition({
  annotations: {
    destructiveHint: false,
    // GitHub returns the existing reaction when the bot already added it.
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "React with an emoji to a GitHub issue or pull request itself, for example to show that you started work on it. Reacting again with the same content changes nothing.",
  inputSchema,
  outputSchema,
});

/** Add the App bot's reaction to an issue or pull request itself. */
export function createGitHubReactToIssueTool(egress: PluginEgress) {
  return definePluginTool({
    ...gitHubReactToIssueToolDefinition,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const response = await githubApi(egress, {
        operation: "github.issue.reaction.create",
        method: "POST",
        path: `${repoPath(repo)}/issues/${input.number}/reactions`,
        body: { content: input.content },
      });
      if (!response.ok) {
        const message = `GitHub issue reaction failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const reaction = z.object({ id: z.number() }).parse(response.body);
      return {
        target: "reactToIssue",
        repo: repo.ref,
        number: input.number,
        content: input.content,
        reaction_id: reaction.id,
      };
    },
  });
}
