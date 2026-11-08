import { githubObjectAnnotation } from "../annotations.js";
import { githubObjectFacts } from "../object-facts.js";
import {
  type PluginEgress,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import { gitHubPullRequestSubscribable } from "../events/pull-request.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
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
  head_sha: commitShaSchema,
  merged: z.boolean(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type PullRequest = z.output<typeof pullRequestSchema>;
interface Result extends PluginToolOutput, PullRequest {
  target: "getPullRequest";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.merge(
  pullRequestSchema.extend({
    target: z.literal("getPullRequest"),
  }),
);
/** Read one PR and expose its stable subscription identity when webhooks are enabled. */
export function createGitHubGetPullRequestTool(ctx: {
  egress: PluginEgress;
  events: { canSubscribe: boolean };
}) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get a GitHub pull request. Use this when an existing PR may need event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const response = await githubApi(ctx.egress, {
        operation: "github.pull.get",
        path: `${repoPath(repo)}/pulls/${input.number}`,
      });
      if (!response.ok) {
        const message = `GitHub pull request lookup failed with HTTP ${response.status}`;
        // Missing PR/repo is model-repairable. Auth, rate limit, and 5xx stay system errors.
        if (response.status === 404) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const providerResult = z
        .object({
          base: z.object({ ref: z.string() }),
          draft: z.boolean(),
          head: z.object({ ref: z.string(), sha: commitShaSchema }),
          html_url: z.string(),
          merged: z.boolean().optional().default(false),
          number: z.number(),
          state: z.string(),
          title: z.string(),
        })
        .parse(response.body);
      const subscribable = gitHubPullRequestSubscribable({
        canSubscribe: ctx.events.canSubscribe,
        number: providerResult.number,
        repo: repo.ref,
      });
      const data: PullRequest = {
        base: providerResult.base.ref,
        draft: providerResult.draft,
        head: providerResult.head.ref,
        head_sha: providerResult.head.sha.toLowerCase(),
        merged: providerResult.merged,
        number: providerResult.number,
        state: providerResult.state,
        ...(subscribable ? { subscribable } : undefined),
        title: providerResult.title,
        url: providerResult.html_url,
      };
      return {
        objectAnnotations: [
          githubObjectAnnotation({
            repo: repo.ref,
            number: data.number,
            title: data.title,
            url: data.url,
            objectType: "code_change",
            status: data.merged
              ? "merged"
              : data.state === "open" && data.draft
                ? "draft"
                : data.state,
            ...githubObjectFacts("code_change", response.body),
          }),
        ],
        target: "getPullRequest",
        ...data,
      };
    },
  });
}
