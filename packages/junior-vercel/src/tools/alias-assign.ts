import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  aliasNameSchema,
  aliasOutputSchema,
  deploymentIdSchema,
  inspectAlias,
  teamSchema,
  vercelRequest,
} from "../tool-support/vercel-api.js";

/** Assign a Vercel alias to a deployment and read it back. */
export const vercelAliasAssignTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Assign an alias hostname to a deployment ID. This can replace live traffic. Reads the alias back and returns matches=false if its target changed or it redirects.",
  inputSchema: z
    .object({
      deployment_id: deploymentIdSchema,
      alias: aliasNameSchema,
      team: teamSchema,
    })
    .strict(),
  outputSchema: aliasOutputSchema.extend({ matches: z.boolean() }),
  async execute(input, _options, ctx) {
    await vercelRequest(
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
      matches: result.deployment_id === input.deployment_id && !result.redirect,
    };
  },
});
