import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type SubscribableResource,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubRepositorySubscribable } from "../resource-events/repository.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
  })
  .strict();
const repositorySchema = z.object({
  defaultBranch: z.string(),
  description: z.string().nullable(),
  fullName: z.string(),
  private: z.boolean(),
  subscribable: subscribableResourceSchema.optional(),
  url: z.string(),
});
type Repository = z.output<typeof repositorySchema>;
interface Result extends PluginToolOutput, Repository {
  target: "getRepository";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("getRepository"),
  ...repositorySchema.shape,
});

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1] };
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

/** Read one repository and expose its stable subscription identity. */
export function createGitHubGetRepositoryTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get a GitHub repository. Use this when repository-wide issue activity may need resource-event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const response = await ctx.egress.fetch({
        provider: "github",
        operation: "github.repository.get",
        request: new Request(
          `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        ),
      });
      const parsed = await readJson(response);
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
        .parse(parsed);
      const subscribable = ctx.resourceEvents.canSubscribe
        ? gitHubRepositorySubscribable({
            repo: providerResult.full_name,
          })
        : undefined;
      const data: Repository = {
        defaultBranch: providerResult.default_branch,
        description: providerResult.description,
        fullName: providerResult.full_name,
        private: providerResult.private,
        ...(subscribable ? { subscribable } : {}),
        url: providerResult.html_url,
      };
      await ctx.annotations?.upsert({
        kind: "resource_link",
        key: providerResult.full_name.toLowerCase(),
        label: providerResult.full_name,
        url: providerResult.html_url,
      });
      return {
        target: "getRepository",
        ...data,
      };
    },
  });
}
