import {
  definePluginTool,
  PluginToolInputError,
  pluginToolResultSchema,
  subscribableResourceSchema,
  type PluginToolResult,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { vercelDeploymentSourceSubscribable } from "../resource-events/deployment-source.js";

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const targetSchema = z.enum(["preview", "production", "staging"]);

const inputSchema = z
  .object({
    commitSha: commitShaSchema.describe("Full 40-character Git commit SHA."),
    projectId: projectIdSchema
      .describe(
        "Vercel project ID. Defaults to the host VERCEL_PROJECT_ID when omitted.",
      )
      .optional(),
    target: targetSchema
      .describe("Deployment target to monitor.")
      .default("production"),
  })
  .strict();

const deploymentSourceSchema = z.object({
  commitSha: commitShaSchema,
  deploymentTarget: targetSchema,
  projectId: projectIdSchema,
  subscribable: subscribableResourceSchema.optional(),
});

type DeploymentSource = z.output<typeof deploymentSourceSchema>;

interface Result extends PluginToolResult, DeploymentSource {
  data: DeploymentSource;
  ok: true;
  status: "success";
  target: "deploymentSource";
}

const outputSchema = pluginToolResultSchema.extend({
  data: deploymentSourceSchema,
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("deploymentSource"),
  ...deploymentSourceSchema.shape,
});

/** Return the resource identity used to monitor one Vercel deployment source. */
export function createVercelDeploymentSourceTool() {
  return definePluginTool({
    description:
      "Describe a Vercel project, deployment target, and full Git commit SHA as a subscribable deployment source. Use this after the final deployed commit is known and before waiting for a deployment outcome.",
    inputSchema,
    outputSchema,
    execute(input): Result {
      const projectId = input.projectId ?? process.env.VERCEL_PROJECT_ID;
      if (!projectId || !projectIdSchema.safeParse(projectId).success) {
        throw new PluginToolInputError(
          "projectId must be a Vercel project ID beginning with prj_, or VERCEL_PROJECT_ID must be configured",
        );
      }
      const commitSha = input.commitSha.toLowerCase();
      const subscribable = vercelDeploymentSourceSubscribable({
        commitSha,
        projectId,
        target: input.target,
        webhookSecret: process.env.VERCEL_WEBHOOK_SECRET,
      });
      const data: DeploymentSource = {
        commitSha,
        deploymentTarget: input.target,
        projectId,
        ...(subscribable ? { subscribable } : {}),
      };
      return {
        data,
        ok: true,
        status: "success",
        target: "deploymentSource",
        ...data,
      };
    },
  });
}
