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
import { gitHubDeploymentSourceSubscribable } from "../resource-events/deployment.js";

const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    commitSha: commitShaSchema.describe(
      "Full 40-character Git commit SHA recorded by the deployment.",
    ),
    environment: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Optional GitHub deployment environment, such as "Production". Omit to inspect and watch deployments for the commit across environments.',
      )
      .optional(),
  })
  .strict();
const statusSchema = z
  .object({
    createdAt: z.string(),
    creator: z.string().nullable(),
    description: z.string().nullable(),
    environmentUrl: z.string().nullable(),
    id: z.number(),
    logUrl: z.string().nullable(),
    state: z.string(),
  })
  .strict();
const deploymentSchema = z
  .object({
    createdAt: z.string(),
    creator: z.string().nullable(),
    description: z.string().nullable(),
    environment: z.string(),
    id: z.number(),
    latestStatus: statusSchema.nullable(),
    ref: z.string(),
    sha: commitShaSchema,
    updatedAt: z.string(),
    url: z.string(),
  })
  .strict();
const deploymentSourceSchema = z
  .object({
    commitSha: commitShaSchema,
    deployment: deploymentSchema.nullable(),
    environment: z.string().nullable(),
    repo: z.string(),
    subscribable: subscribableResourceSchema.optional(),
  })
  .strict();
type DeploymentSource = z.output<typeof deploymentSourceSchema>;
interface Result extends PluginToolOutput, DeploymentSource {
  subscribable?: SubscribableResource;
  target: "getDeployment";
}
const outputSchema = pluginToolOutputSchema
  .extend({
    target: z.literal("getDeployment"),
    ...deploymentSourceSchema.shape,
  })
  .strict();

const providerCreatorSchema = z
  .object({ login: z.string() })
  .passthrough()
  .nullable();
const providerDeploymentSchema = z
  .object({
    created_at: z.string(),
    creator: providerCreatorSchema,
    description: z.string().nullable(),
    environment: z.string(),
    id: z.number(),
    ref: z.string(),
    sha: commitShaSchema,
    updated_at: z.string(),
  })
  .passthrough();
const providerStatusSchema = z
  .object({
    created_at: z.string(),
    creator: providerCreatorSchema,
    description: z.string().nullable().optional(),
    environment_url: z.string().nullable().optional(),
    id: z.number(),
    log_url: z.string().nullable().optional(),
    state: z.string(),
  })
  .passthrough();

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

/** Read a provider response without assuming its error body is JSON. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Route repairable lookup failures through the model-visible tool error path. */
function throwLookupError(
  target: "deployment" | "deployment status",
  status: number,
  body: unknown,
): never {
  const message = `GitHub ${target} lookup failed with HTTP ${status}`;
  const hasValidationErrors =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Array.isArray((body as { errors?: unknown }).errors) &&
    (body as { errors: unknown[] }).errors.length > 0;
  if (
    target === "deployment" &&
    (status === 404 || (status === 422 && hasValidationErrors))
  ) {
    throw new PluginToolInputError(message);
  }
  throw new Error(message);
}

function repositoryUrl(repo: { name: string; owner: string }, path: string) {
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${path}`;
}

/** Read deployment metadata and expose its stable subscription identity. */
export function createGitHubGetDeploymentTool(
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
      "Get the latest GitHub deployment and status for an exact repository and full commit SHA, optionally limited to one environment. The result remains subscribable when no deployment exists yet, so use it before waiting for a deployment outcome.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const commitSha = input.commitSha.toLowerCase();
      const deploymentsUrl = new URL(repositoryUrl(repo, "deployments"));
      deploymentsUrl.searchParams.set("sha", commitSha);
      if (input.environment) {
        deploymentsUrl.searchParams.set("environment", input.environment);
      }
      deploymentsUrl.searchParams.set("per_page", "1");
      const deploymentsResponse = await ctx.egress.fetch({
        provider: "github",
        operation: "github.deployment.list",
        request: new Request(deploymentsUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      });
      const deploymentsBody = await readJson(deploymentsResponse);
      if (!deploymentsResponse.ok) {
        throwLookupError(
          "deployment",
          deploymentsResponse.status,
          deploymentsBody,
        );
      }
      const providerDeployment = z
        .array(providerDeploymentSchema)
        .parse(deploymentsBody)[0];

      let deployment: z.output<typeof deploymentSchema> | null = null;
      if (providerDeployment) {
        const statusesResponse = await ctx.egress.fetch({
          provider: "github",
          operation: "github.deployment-status.list",
          request: new Request(
            `${repositoryUrl(repo, `deployments/${providerDeployment.id}/statuses`)}?per_page=1`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            },
          ),
        });
        const statusesBody = await readJson(statusesResponse);
        if (!statusesResponse.ok) {
          throwLookupError(
            "deployment status",
            statusesResponse.status,
            statusesBody,
          );
        }
        const providerStatus = z
          .array(providerStatusSchema)
          .parse(statusesBody)[0];
        deployment = {
          createdAt: providerDeployment.created_at,
          creator: providerDeployment.creator?.login ?? null,
          description: providerDeployment.description,
          environment: providerDeployment.environment,
          id: providerDeployment.id,
          latestStatus: providerStatus
            ? {
                createdAt: providerStatus.created_at,
                creator: providerStatus.creator?.login ?? null,
                description: providerStatus.description ?? null,
                environmentUrl: providerStatus.environment_url ?? null,
                id: providerStatus.id,
                logUrl: providerStatus.log_url ?? null,
                state: providerStatus.state,
              }
            : null,
          ref: providerDeployment.ref,
          sha: providerDeployment.sha.toLowerCase(),
          updatedAt: providerDeployment.updated_at,
          url: `https://github.com/${repo.ref}/deployments`,
        };
      }

      const subscribable = ctx.resourceEvents.canSubscribe
        ? gitHubDeploymentSourceSubscribable({
            commitSha,
            environment: input.environment,
            repo: repo.ref,
          })
        : undefined;
      const data: DeploymentSource = {
        commitSha,
        deployment,
        environment: input.environment ?? null,
        repo: repo.ref,
        ...(subscribable ? { subscribable } : undefined),
      };
      return {
        target: "getDeployment",
        ...data,
      };
    },
  });
}
