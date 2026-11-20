import { definePluginTool } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  aliasNameSchema,
  aliasOutputSchema,
  inspectAlias,
  teamSchema,
} from "../tool-support/vercel-api.js";

/** Read a Vercel alias. */
export const vercelAliasInspectTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description: "Read a Vercel alias's current deployment ID or redirect.",
  inputSchema: z.object({ alias: aliasNameSchema, team: teamSchema }).strict(),
  outputSchema: aliasOutputSchema,
  async execute(input, _options, ctx) {
    return inspectAlias(ctx.egress, input.alias, input.team);
  },
});
