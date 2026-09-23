import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

// General Vercel operations use the existing host credential and tool review.
// Return only task-relevant fields; deployment responses can contain secrets.
const text = z.string().trim().min(1);
const team = text
  .describe(
    "Vercel team slug or team_ ID. Omit for the token's default account.",
  )
  .optional();
const deploymentId = z
  .string()
  .regex(/^dpl_[a-zA-Z0-9]+$/)
  .describe("Exact Vercel deployment ID, not an alias.");
const aliasName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/)
  .describe("Alias hostname without a scheme or path.");
const deploymentSchema = z.object({
  id: text,
  url: text,
  readyState: text,
  target: z.string().nullable().optional(),
  projectId: text.optional(),
  gitSource: z
    .object({ sha: text.optional(), ref: text.optional() })
    .nullable()
    .optional(),
});
const deploymentOutput = pluginToolOutputSchema.extend({
  target: z.literal("deployment"),
  deploymentId: text,
  url: text,
  state: text,
  deploymentTarget: z.string().nullable(),
  projectId: text.nullable(),
  commitSha: text.nullable(),
  ref: text.nullable(),
});
const aliasSchema = z.object({
  alias: text,
  deploymentId: text.nullable(),
  redirect: text.nullable().optional(),
});
const aliasOutput = pluginToolOutputSchema.extend({
  target: z.literal("alias"),
  alias: text,
  deploymentId: text.nullable(),
  redirect: text.nullable(),
});

function deploymentResult(data: unknown) {
  const value = deploymentSchema.parse(data);
  return {
    target: "deployment" as const,
    deploymentId: value.id,
    url: `https://${value.url}`,
    state: value.readyState,
    deploymentTarget: value.target ?? null,
    projectId: value.projectId ?? null,
    commitSha: value.gitSource?.sha ?? null,
    ref: value.gitSource?.ref ?? null,
  };
}

/** Register general deployment and alias operations under normal host review. */
export function createVercelActionTools(ctx: ToolRegistrationHookContext) {
  async function request(
    operation: string,
    path: string,
    scope?: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(path, "https://api.vercel.com");
    if (scope)
      url.searchParams.set(
        scope.startsWith("team_") ? "teamId" : "slug",
        scope,
      );
    const init: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await ctx.egress.fetch({
      provider: "vercel",
      operation,
      request: new Request(url, init),
    });
    if (!response.ok) {
      const message = `Vercel ${operation} failed with HTTP ${response.status}`;
      if (response.status === 400 || response.status === 404)
        throw new PluginToolInputError(message);
      throw new Error(message);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }
  async function inspectAlias(alias: string, scope?: string) {
    const result = aliasSchema.parse(
      await request(
        "vercel.alias.get",
        `/v4/aliases/${encodeURIComponent(alias)}`,
        scope,
      ),
    );
    return {
      target: "alias" as const,
      alias: result.alias,
      deploymentId: result.deploymentId,
      redirect: result.redirect ?? null,
    };
  }
  return {
    deployment_create: definePluginTool({
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Deploy a Git ref from an existing Vercel project's linked GitHub repository. Defaults to Preview; use production only when requested. Inherits project build settings and environment credentials and may run migrations. Supply commitSha to pin the build while retaining branch context in ref. Use explicit project/team targets or conversation defaults. Inspect deployments before retrying an uncertain create.",
      inputSchema: z
        .object({
          project: text.describe("Existing Vercel project name or ID."),
          team,
          ref: text.describe(
            "Git branch, tag, or full commit SHA in the project's linked repository.",
          ),
          commitSha: z
            .string()
            .regex(/^[a-f0-9]{40}$/i)
            .describe("Optional full commit SHA to pin the source.")
            .optional(),
          target: z
            .enum(["preview", "production"])
            .describe("Deployment environment; defaults to preview.")
            .optional(),
        })
        .strict(),
      outputSchema: deploymentOutput,
      async execute(input) {
        const project = z
          .object({
            id: text,
            name: text,
            link: z
              .object({ type: text, repoId: z.union([text, z.number()]) })
              .nullable()
              .optional(),
          })
          .parse(
            await request(
              "vercel.project.get",
              `/v9/projects/${encodeURIComponent(input.project)}`,
              input.team,
            ),
          );
        if (project.link?.type !== "github")
          throw new PluginToolInputError(
            "This deployment tool requires a project linked to GitHub. Use the Vercel CLI for other source types.",
          );
        const gitSource = {
          type: "github",
          repoId: project.link.repoId,
          ref: input.ref,
          ...(input.commitSha
            ? { sha: input.commitSha.toLowerCase() }
            : undefined),
        };
        return deploymentResult(
          await request(
            "vercel.deployment.create",
            "/v13/deployments",
            input.team,
            "POST",
            {
              name: project.name,
              project: project.id,
              target: input.target ?? "preview",
              gitSource,
            },
          ),
        );
      },
    }),
    deployment_inspect: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Inspect a Vercel deployment by ID or hostname, including an alias hostname. Returns deployment ID, state, environment, and source when available. Compare deployment IDs before and after QA; an alias can change between checks. Use the CLI for logs or additional deployment details.",
      inputSchema: z
        .object({
          deployment: text.describe(
            "Deployment ID or hostname, without a scheme or path.",
          ),
          team,
        })
        .strict(),
      outputSchema: deploymentOutput,
      async execute(input) {
        return deploymentResult(
          await request(
            "vercel.deployment.get",
            `/v13/deployments/${encodeURIComponent(input.deployment)}?withGitRepoInfo=true`,
            input.team,
          ),
        );
      },
    }),
    alias_assign: definePluginTool({
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Assign an alias hostname to an exact Vercel deployment ID. Replaces its existing target and can redirect live traffic. Returns the alias target read back after assignment and whether it matches. Does not acquire a lock or stop older workers. Do not overwrite a changed alias as automatic recovery.",
      inputSchema: z.object({ deploymentId, alias: aliasName, team }).strict(),
      outputSchema: aliasOutput.extend({ matches: z.boolean() }),
      async execute(input) {
        await request(
          "vercel.alias.assign",
          `/v2/deployments/${encodeURIComponent(input.deploymentId)}/aliases`,
          input.team,
          "POST",
          { alias: input.alias },
        );
        const result = await inspectAlias(input.alias, input.team);
        return {
          ...result,
          matches:
            result.deploymentId === input.deploymentId && !result.redirect,
        };
      },
    }),
    alias_inspect: definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Read a Vercel alias's current deployment ID or redirect. Use to detect alias changes before and after testing. This is a point-in-time observation, not a lock.",
      inputSchema: z.object({ alias: aliasName, team }).strict(),
      outputSchema: aliasOutput,
      async execute(input) {
        return inspectAlias(input.alias, input.team);
      },
    }),
    deployment_delete: definePluginTool({
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Delete an exact Vercel deployment ID in the selected team. This can remove a live deployment; act only on the user's requested target. Does not delete its database or Redis state. Do not automatically delete deployments as QA cleanup.",
      inputSchema: z.object({ deploymentId, team }).strict(),
      outputSchema: pluginToolOutputSchema.extend({
        target: z.literal("deployment"),
        deploymentId: text,
        deleted: z.literal(true),
      }),
      async execute(input) {
        await request(
          "vercel.deployment.delete",
          `/v13/deployments/${encodeURIComponent(input.deploymentId)}`,
          input.team,
          "DELETE",
        );
        return {
          target: "deployment" as const,
          deploymentId: input.deploymentId,
          deleted: true as const,
        };
      },
    }),
  };
}
