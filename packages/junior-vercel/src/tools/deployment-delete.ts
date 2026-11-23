import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  deploymentIdSchema,
  nonEmptyText,
  teamSchema,
  vercelRequest,
} from "../tool-support/vercel-api.js";

/** Delete a Vercel deployment. */
export const vercelDeploymentDeleteTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Delete a Vercel deployment by ID. This can remove a live deployment. Does not delete its database or other external state.",
  inputSchema: z
    .object({ deployment_id: deploymentIdSchema, team: teamSchema })
    .strict(),
  outputSchema: pluginToolOutputSchema.extend({
    target: z.literal("deployment"),
    deployment_id: nonEmptyText,
    deleted: z.literal(true),
  }),
  async execute(input, _options, ctx) {
    await vercelRequest(
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
});
