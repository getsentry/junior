import {
  definePluginTool,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  deploymentOutputSchema,
  deploymentResult,
  nonEmptyText,
  teamSchema,
  vercelRequest,
} from "../tool-support/vercel-api.js";

/** Start a Vercel deployment from a linked GitHub repository. */
export const vercelDeploymentCreateTool = definePluginTool({
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
      project: nonEmptyText.describe("Existing Vercel project name or ID."),
      team: teamSchema,
      ref: nonEmptyText.describe(
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
  // A deployment URL is public unless the project protects it, which the
  // call does not show.
  guardian: async (input) => ({
    target: `Vercel project ${input.project} (${input.target ?? "preview"})`,
    audience: "world",
  }),
  outputSchema: deploymentOutputSchema,
  async execute(input, _options, ctx) {
    const project = z
      .object({
        id: nonEmptyText,
        name: nonEmptyText,
        link: z
          .object({
            type: nonEmptyText,
            repoId: z.union([nonEmptyText, z.number()]).optional(),
          })
          .nullable()
          .optional(),
      })
      .parse(
        await vercelRequest(
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
      await vercelRequest(
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
      "created",
    );
  },
});
