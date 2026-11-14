import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginEgress,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

// Deployment and alias tools return selected fields because Vercel responses
// can contain environment credentials.
const text = z.string().trim().min(1);
const team = text
  .describe(
    "Vercel team slug or team_ ID. Omit for the token's default account.",
  )
  .optional();
const deploymentIdSchema = z
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
  deployment_id: text,
  url: text,
  state: text,
  deployment_target: z.string().nullable(),
  project_id: text.nullable(),
  commit_sha: text.nullable(),
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
  deployment_id: text.nullable(),
  redirect: text.nullable(),
});

function deploymentResult(data: unknown) {
  const value = deploymentSchema.parse(data);
  return {
    target: "deployment" as const,
    deployment_id: value.id,
    url: `https://${value.url}`,
    state: value.readyState,
    deployment_target: value.target ?? null,
    project_id: value.projectId ?? null,
    commit_sha: value.gitSource?.sha ?? null,
    ref: value.gitSource?.ref ?? null,
    objectAnnotations: [
      {
        kind: "object",
        objectType: "deployment",
        displayType: "Deployment",
        key: value.id,
        label: value.id,
        title: value.url.slice(0, 512),
        url: `https://${value.url}`,
        status: value.readyState,
        facts: {
          type: "deployment",
          project: value.projectId?.slice(0, 64),
          environment: value.target?.slice(0, 64) ?? undefined,
          revision: value.gitSource?.sha?.slice(0, 64),
          branch: value.gitSource?.ref?.slice(0, 64),
        },
      } satisfies ObjectAnnotation,
    ],
  };
}

async function request(
  egress: PluginEgress,
  operation: string,
  path: string,
  scope?: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const url = new URL(path, "https://api.vercel.com");
  if (scope)
    url.searchParams.set(scope.startsWith("team_") ? "teamId" : "slug", scope);
  const init: RequestInit = {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await egress.fetch({
    provider: "vercel",
    operation,
    request: new Request(url, init),
  });
  if (!response.ok) {
    const message = `${operation} failed with HTTP ${response.status}`;
    if (response.status === 400 || response.status === 404)
      throw new PluginToolInputError(message);
    throw new Error(message);
  }
  if (response.status === 204) return undefined;
  return response.json();
}
async function inspectAlias(
  egress: PluginEgress,
  alias: string,
  scope?: string,
) {
  const result = aliasSchema.parse(
    await request(
      egress,
      "vercel.alias.get",
      `/v4/aliases/${encodeURIComponent(alias)}`,
      scope,
    ),
  );
  return {
    target: "alias" as const,
    alias: result.alias,
    deployment_id: result.deploymentId,
    redirect: result.redirect ?? null,
  };
}
/** Vercel deployment and alias operations. */
export const vercelActionTools = {
  deploymentCreate: definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Start a deployment from a Vercel project's linked GitHub repository. Uses project build settings and environment credentials, so builds may run migrations. Returns the new deployment; inspect it to check readiness.",
    inputSchema: z
      .object({
        project: text.describe("Existing Vercel project name or ID."),
        team,
        ref: text.describe(
          "Git branch, tag, or full commit SHA in the project's linked repository.",
        ),
        commit_sha: z
          .string()
          .regex(/^[a-f0-9]{40}$/i)
          .describe(
            "Full commit SHA to pin the source while retaining branch context in ref.",
          )
          .optional(),
        target: z
          .enum(["preview", "production"])
          .describe("Deployment environment; defaults to preview.")
          .optional(),
      })
      .strict(),
    outputSchema: deploymentOutput,
    async execute(input, _options, ctx) {
      const project = z
        .object({
          id: text,
          name: text,
          link: z
            .object({
              type: text,
              repoId: z.union([text, z.number()]).optional(),
            })
            .nullable()
            .optional(),
        })
        .parse(
          await request(
            ctx.egress,
            "vercel.project.get",
            `/v9/projects/${encodeURIComponent(input.project)}`,
            input.team,
          ),
        );
      if (project.link?.type !== "github" || !project.link.repoId)
        throw new PluginToolInputError(
          "This deployment tool requires a project linked to GitHub. Use the Vercel CLI for other source types.",
        );
      const gitSource = {
        type: "github",
        repoId: project.link.repoId,
        ref: input.ref,
        sha: input.commit_sha?.toLowerCase(),
      };
      return deploymentResult(
        await request(
          ctx.egress,
          "vercel.deployment.create",
          "/v13/deployments",
          input.team,
          "POST",
          {
            name: project.name,
            project: project.id,
            // Vercel uses an omitted target for Preview, not "preview".
            target: input.target === "production" ? "production" : undefined,
            gitSource,
          },
        ),
      );
    },
  }),
  deploymentInspect: definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Inspect a Vercel deployment by ID or hostname. Returns its ID, state, environment, and Git source when available. Use the CLI for logs.",
    inputSchema: z
      .object({
        deployment: text.describe(
          "Deployment ID or hostname, without a scheme or path.",
        ),
        team,
      })
      .strict(),
    outputSchema: deploymentOutput,
    async execute(input, _options, ctx) {
      return deploymentResult(
        await request(
          ctx.egress,
          "vercel.deployment.get",
          `/v13/deployments/${encodeURIComponent(input.deployment)}?withGitRepoInfo=true`,
          input.team,
        ),
      );
    },
  }),
  aliasAssign: definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Assign an alias hostname to a deployment ID. This can replace live traffic. Reads the alias back and returns matches=false if its target changed or it redirects.",
    inputSchema: z
      .object({ deployment_id: deploymentIdSchema, alias: aliasName, team })
      .strict(),
    outputSchema: aliasOutput.extend({ matches: z.boolean() }),
    async execute(input, _options, ctx) {
      await request(
        ctx.egress,
        "vercel.alias.assign",
        `/v2/deployments/${encodeURIComponent(input.deployment_id)}/aliases`,
        input.team,
        "POST",
        { alias: input.alias },
      );
      const result = await inspectAlias(ctx.egress, input.alias, input.team);
      return {
        ...result,
        matches:
          result.deployment_id === input.deployment_id && !result.redirect,
      };
    },
  }),
  aliasInspect: definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description: "Read a Vercel alias's current deployment ID or redirect.",
    inputSchema: z.object({ alias: aliasName, team }).strict(),
    outputSchema: aliasOutput,
    async execute(input, _options, ctx) {
      return inspectAlias(ctx.egress, input.alias, input.team);
    },
  }),
  deploymentDelete: definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Delete a Vercel deployment by ID. This can remove a live deployment. Does not delete its database or other external state.",
    inputSchema: z.object({ deployment_id: deploymentIdSchema, team }).strict(),
    outputSchema: pluginToolOutputSchema.extend({
      target: z.literal("deployment"),
      deployment_id: text,
      deleted: z.literal(true),
    }),
    async execute(input, _options, ctx) {
      await request(
        ctx.egress,
        "vercel.deployment.delete",
        `/v13/deployments/${encodeURIComponent(input.deployment_id)}`,
        input.team,
        "DELETE",
      );
      return {
        target: "deployment" as const,
        deployment_id: input.deployment_id,
        deleted: true as const,
      };
    },
  }),
};
