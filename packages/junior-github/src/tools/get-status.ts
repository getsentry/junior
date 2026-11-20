import {
  definePluginTool,
  type PluginCache,
  pluginToolOutputSchema,
  type PluginToolOutput,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { loadGitHubStatusIncidents } from "../github-status.js";

const RECENT_INCIDENT_MS = 24 * 60 * 60 * 1000;

const inputSchema = z.object({}).strict();
const incidentSchema = z.object({
  components: z.array(z.string()),
  impact: z.string(),
  name: z.string(),
  resolved_at: z.string().optional(),
  started_at: z.string(),
  status: z.string(),
  url: z.string(),
});
const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("getStatus"),
  incidents: z.array(incidentSchema),
});
interface Result extends PluginToolOutput {
  target: "getStatus";
  incidents: z.output<typeof incidentSchema>[];
}

/** Read open and recent GitHub incidents to tell outages from other failures. */
export const gitHubGetStatusTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "List GitHub incidents from githubstatus.com that are open or were resolved in the last 24 hours, with their affected components. Use when a GitHub request fails with a 5xx, a timeout, or a dropped connection, or when checks stay queued or fail with no cause in the logs.",
  inputSchema,
  outputSchema,
  async execute(
    _input,
    _options,
    ctx: { cache: PluginCache },
  ): Promise<Result> {
    const incidents = await loadGitHubStatusIncidents(
      ctx.cache,
      RECENT_INCIDENT_MS,
    );
    return {
      target: "getStatus",
      incidents: incidents.map(({ resolvedAt, startedAt, ...incident }) => {
        const result: z.output<typeof incidentSchema> = {
          ...incident,
          started_at: startedAt,
        };
        if (resolvedAt) result.resolved_at = resolvedAt;
        return result;
      }),
    };
  },
});
