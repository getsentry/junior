import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { readVercelPreviewProject } from "../credentials.js";
import {
  parseVercelPreview,
  previewCommitSchema,
  previewDeploymentIdSchema,
  readVercelPreviewResponse,
  vercelPreviewUrl,
  type VercelPreviewOptions,
} from "../preview.js";

const identity = z
  .object({
    deploymentId: previewDeploymentIdSchema,
    commitSha: previewCommitSchema,
  })
  .strict();
const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("preview"),
  deploymentId: previewDeploymentIdSchema,
  commitSha: previewCommitSchema,
  state: z.string(),
  alias: z.string(),
  aliasMatches: z.boolean().optional(),
});

/** Expose fixed-scope Preview actions without accepting provider settings or secrets. */
export function createVercelPreviewTools(
  ctx: ToolRegistrationHookContext,
  scope: VercelPreviewOptions,
) {
  async function request(
    operation: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const init: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return ctx.egress.fetch({
      provider: "vercel",
      operation: `vercel.preview.${operation}`,
      request: new Request(vercelPreviewUrl(scope, path), init),
    });
  }
  async function deployment(input: z.infer<typeof identity>) {
    const data = await readVercelPreviewResponse(
      await request(
        "get",
        `/v13/deployments/${input.deploymentId}?withGitRepoInfo=true`,
      ),
    );
    const result = parseVercelPreview(data, scope, input.commitSha);
    if (result.id !== input.deploymentId)
      throw new PluginToolInputError("Unexpected Vercel deployment ID.");
    return result;
  }
  async function aliasMatches(deploymentId: string) {
    const response = await request(
      "alias.get",
      `/v4/aliases/${encodeURIComponent(scope.alias)}`,
    );
    if (response.status === 404) return false;
    const alias = z
      .object({
        deploymentId: z.string().nullable(),
        redirect: z.string().nullable().optional(),
      })
      .parse(await readVercelPreviewResponse(response));
    return alias.deploymentId === deploymentId && !alias.redirect;
  }
  const annotations = {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  };
  return {
    preview_create: definePluginTool({
      annotations: { ...annotations, idempotentHint: false },
      description:
        "Build an exact GitHub commit as a Vercel Preview in the host-configured project. Inherits Preview build settings and credentials, so use only trusted commits after isolated Preview state is configured. No Production deploy, files, or setting overrides. Does not select the QA alias. Do not retry an uncertain create without inspecting deployments first.",
      inputSchema: z.object({ commitSha: previewCommitSchema }).strict(),
      outputSchema,
      async execute(input) {
        const project = await readVercelPreviewProject(scope);
        const [org, repo] = scope.repository.split("/");
        const data = await readVercelPreviewResponse(
          await request("create", "/v13/deployments", "POST", {
            name: project.name,
            project: scope.projectId,
            target: "preview",
            gitSource: {
              type: "github",
              org,
              repo,
              ref: input.commitSha,
              sha: input.commitSha,
            },
          }),
        );
        const result = z
          .object({ id: previewDeploymentIdSchema, readyState: z.string() })
          .parse(data);
        return {
          target: "preview" as const,
          deploymentId: result.id,
          commitSha: input.commitSha,
          state: result.readyState,
          alias: scope.alias,
        };
      },
    }),
    preview_inspect: definePluginTool({
      annotations: { ...annotations, readOnlyHint: true },
      description:
        "Inspect an exact Preview deployment and check whether the configured QA alias points to it. Check before and after Slack QA. aliasMatches=false means stop and mark results inconclusive. This is a point-in-time check, not a lock; it does not stop old workers.",
      inputSchema: identity,
      outputSchema,
      async execute(input) {
        const result = await deployment(input);
        return {
          target: "preview" as const,
          ...input,
          state: result.readyState,
          alias: scope.alias,
          aliasMatches: await aliasMatches(input.deploymentId),
        };
      },
    }),
    preview_select: definePluginTool({
      annotations: { ...annotations, destructiveHint: true },
      description:
        "Point the host-configured QA alias at a ready Preview of the exact commit. Replaces the current alias target. Coordinate with other testers; this is not a lock. Does not change Slack app settings or stop old workers. Read back the alias after assignment; if it differs, stop rather than overwrite it again.",
      inputSchema: identity,
      outputSchema,
      async execute(input) {
        const result = await deployment(input);
        if (result.readyState !== "READY")
          throw new PluginToolInputError(
            "Preview must be READY before alias selection.",
          );
        await readVercelPreviewResponse(
          await request(
            "select",
            `/v2/deployments/${input.deploymentId}/aliases`,
            "POST",
            { alias: scope.alias },
          ),
        );
        return {
          target: "preview" as const,
          ...input,
          state: result.readyState,
          alias: scope.alias,
          aliasMatches: await aliasMatches(input.deploymentId),
        };
      },
    }),
    preview_delete: definePluginTool({
      annotations: { ...annotations, destructiveHint: true },
      description:
        "Delete an exact Preview in the configured project only when explicitly requested. Does not delete its database or Redis state. Never use automatic cleanup to restore or remove the shared QA alias; another tester may be using it.",
      inputSchema: identity,
      outputSchema,
      async execute(input) {
        await deployment(input);
        const response = await request(
          "delete",
          `/v13/deployments/${input.deploymentId}`,
          "DELETE",
        );
        if (!response.ok) await readVercelPreviewResponse(response);
        return {
          target: "preview" as const,
          ...input,
          state: "DELETED",
          alias: scope.alias,
        };
      },
    }),
  };
}
