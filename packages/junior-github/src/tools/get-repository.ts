import {
  type PluginEgress,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubRepositorySubscribable } from "../events/repository.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
  })
  .strict();
const repositorySchema = z.object({
  default_branch: z.string(),
  description: z.string().nullable(),
  full_name: z.string(),
  private: z.boolean(),
  subscribable: subscribableResourceSchema.optional(),
  url: z.string(),
});
type Repository = z.output<typeof repositorySchema>;
interface Result extends PluginToolOutput, Repository {
  target: "getRepository";
  subscribable?: SubscribableResource | undefined;
}
const outputSchema = pluginToolOutputSchema.merge(
  repositorySchema.extend({
    target: z.literal("getRepository"),
  }),
);

/** Read one repository and expose its stable subscription identity. */
export const gitHubGetRepositoryTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Get a GitHub repository. Use this when repository-wide issue activity may need event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
  inputSchema,
  outputSchema,
  async execute(
    input,
    _options,
    ctx: {
      egress: PluginEgress;
      events: { canSubscribe: boolean };
    },
  ): Promise<Result> {
    const repo = parseRepo(input.repo);
    const response = await githubApi(ctx.egress, {
      operation: "github.repository.get",
      path: repoPath(repo),
    });
    if (!response.ok) {
      throw new PluginToolInputError(
        `GitHub repository lookup failed with HTTP ${response.status}`,
      );
    }
    const providerResult = z
      .object({
        default_branch: z.string(),
        description: z.string().nullable(),
        full_name: z.string(),
        html_url: z.string(),
        private: z.boolean(),
      })
      .parse(response.body);
    const subscribable = gitHubRepositorySubscribable({
      canSubscribe: ctx.events.canSubscribe,
      repo: providerResult.full_name,
    });
    const data: Repository = {
      default_branch: providerResult.default_branch,
      description: providerResult.description,
      full_name: providerResult.full_name,
      private: providerResult.private,
      ...(subscribable ? { subscribable } : undefined),
      url: providerResult.html_url,
    };
    return {
      target: "getRepository",
      ...data,
    };
  },
});
