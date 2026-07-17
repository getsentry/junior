import {
  definePluginTool,
  PluginToolInputError,
  pluginToolResultSchema,
  type PluginToolResult,
  type SubscribableResource,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import { gitHubPullRequestSubscribable } from "../resource-events/pull-request.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
  })
  .strict();
const pullRequestSchema = z.object({
  base: z.string(),
  draft: z.boolean(),
  head: z.string(),
  merged: z.boolean(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type PullRequest = z.output<typeof pullRequestSchema>;
interface Result extends PluginToolResult, PullRequest {
  ok: true;
  status: "success";
  target: "getPullRequest";
  data: PullRequest;
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("getPullRequest"),
  data: pullRequestSchema,
  ...pullRequestSchema.shape,
});
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

/** Read one PR and expose its stable subscription identity when webhooks are enabled. */
export function createGitHubGetPullRequestTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    description:
      "Get a GitHub pull request. Use this when an existing PR may need resource-event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const response = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.get",
        request: new Request(
          `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${input.number}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        ),
      });
      const parsed = await readJson(response);
      if (!response.ok)
        throw new Error(
          `GitHub pull request lookup failed with HTTP ${response.status}`,
        );
      const providerResult = z
        .object({
          base: z.object({ ref: z.string() }),
          draft: z.boolean(),
          head: z.object({ ref: z.string() }),
          html_url: z.string(),
          merged: z.boolean().optional().default(false),
          number: z.number(),
          state: z.string(),
          title: z.string(),
        })
        .parse(parsed);
      const subscribable = gitHubPullRequestSubscribable({
        number: providerResult.number,
        repo: repo.ref,
      });
      const data: PullRequest = {
        base: providerResult.base.ref,
        draft: providerResult.draft,
        head: providerResult.head.ref,
        merged: providerResult.merged,
        number: providerResult.number,
        state: providerResult.state,
        ...(subscribable ? { subscribable } : {}),
        title: providerResult.title,
        url: providerResult.html_url,
      };
      return {
        ok: true,
        status: "success",
        target: "getPullRequest",
        data,
        ...data,
      };
    },
  });
}
