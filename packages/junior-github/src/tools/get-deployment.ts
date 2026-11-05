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
import { gitHubDeploymentSourceSubscribable } from "../events/deployment.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    commit_sha: commitShaSchema.describe(
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
    created_at: z.string(),
    creator: z.string().nullable(),
    description: z.string().nullable(),
    environment_url: z.string().nullable(),
    id: z.number(),
    log_url: z.string().nullable(),
    state: z.string(),
  })
  .strict();
const deploymentSchema = z
  .object({
    created_at: z.string(),
    creator: z.string().nullable(),
    description: z.string().nullable(),
    environment: z.string(),
    id: z.number(),
    latest_status: statusSchema.nullable(),
    ref: z.string(),
    sha: commitShaSchema,
    updated_at: z.string(),
    url: z.string(),
  })
  .strict();
const deploymentSourceSchema = z
  .object({
    commit_sha: commitShaSchema,
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
const outputSchema = pluginToolOutputSchema.merge(
  deploymentSourceSchema.extend({
    target: z.literal("getDeployment"),
  }),
);

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

/** Read deployment metadata and expose its stable subscription identity. */
export function createGitHubGetDeploymentTool(ctx: {
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
      "Get the latest GitHub deployment and status for an exact repository and full commit SHA, optionally limited to one environment. The result remains subscribable when no deployment exists yet, so use it before waiting for a deployment outcome.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const commitSha = input.commit_sha.toLowerCase();
      const deploymentsQuery = new URLSearchParams({ sha: commitSha });
      if (input.environment) {
        deploymentsQuery.set("environment", input.environment);
      }
      deploymentsQuery.set("per_page", "1");
      const deployments = await githubApi(ctx.egress, {
        operation: "github.deployment.list",
        path: `${repoPath(repo)}/deployments?${deploymentsQuery}`,
      });
      if (!deployments.ok) {
        throwLookupError("deployment", deployments.status, deployments.body);
      }
      const providerDeployment = z
        .array(providerDeploymentSchema)
        .parse(deployments.body)[0];

      let deployment: z.output<typeof deploymentSchema> | null = null;
      if (providerDeployment) {
        const statuses = await githubApi(ctx.egress, {
          operation: "github.deployment-status.list",
          path: `${repoPath(repo)}/deployments/${providerDeployment.id}/statuses?per_page=1`,
        });
        if (!statuses.ok) {
          throwLookupError("deployment status", statuses.status, statuses.body);
        }
        const providerStatus = z
          .array(providerStatusSchema)
          .parse(statuses.body)[0];
        deployment = {
          created_at: providerDeployment.created_at,
          creator: providerDeployment.creator?.login ?? null,
          description: providerDeployment.description,
          environment: providerDeployment.environment,
          id: providerDeployment.id,
          latest_status: providerStatus
            ? {
                created_at: providerStatus.created_at,
                creator: providerStatus.creator?.login ?? null,
                description: providerStatus.description ?? null,
                environment_url: providerStatus.environment_url ?? null,
                id: providerStatus.id,
                log_url: providerStatus.log_url ?? null,
                state: providerStatus.state,
              }
            : null,
          ref: providerDeployment.ref,
          sha: providerDeployment.sha.toLowerCase(),
          updated_at: providerDeployment.updated_at,
          url: `https://github.com/${repo.ref}/deployments`,
        };
      }

      const subscribable = gitHubDeploymentSourceSubscribable({
        canSubscribe: ctx.events.canSubscribe,
        commitSha,
        environment: input.environment,
        repo: repo.ref,
      });
      const data: DeploymentSource = {
        commit_sha: commitSha,
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
