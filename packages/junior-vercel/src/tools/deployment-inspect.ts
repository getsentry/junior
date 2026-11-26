import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  deploymentOutputSchema,
  deploymentResult,
  nonEmptyText,
  teamSchema,
  vercelRequest,
} from "../tool-support/vercel-api.js";

/** Inspect a Vercel deployment. */
export const vercelDeploymentInspectTool = definePluginTool({
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
      deployment: nonEmptyText.describe(
        "Deployment ID or hostname, without a scheme or path.",
      ),
      team: teamSchema,
    })
    .strict(),
  outputSchema: deploymentOutputSchema,
  async execute(input, _options, ctx) {
    return deploymentResult(
      await vercelRequest(
        ctx.egress,
        "vercel.deployment.get",
        `/v13/deployments/${encodeURIComponent(input.deployment)}?withGitRepoInfo=true`,
        input.team,
      ),
    );
  },
});
