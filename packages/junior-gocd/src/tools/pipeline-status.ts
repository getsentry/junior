import {
  definePluginTool,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  resolveGocdApiUrl,
  resolveGocdBaseUrl,
  type GocdPluginOptions,
} from "../config.js";

const inputSchema = z
  .object({
    pipeline: z.string().trim().min(1).describe("Exact GoCD pipeline name."),
  })
  .strict();

const bodySchema = z
  .object({
    paused: z.boolean(),
    locked: z.boolean(),
    schedulable: z.boolean(),
  })
  .passthrough();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("pipeline_status"),
  baseUrl: z.string(),
  pipeline: z.string(),
  paused: z.boolean(),
  locked: z.boolean(),
  schedulable: z.boolean(),
});

type Result = PluginToolOutput & z.infer<typeof outputSchema>;

/** Return the current state for one GoCD pipeline. */
export function createGocdPipelineStatusTool(
  ctx: ToolRegistrationHookContext,
  options: GocdPluginOptions = {},
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Check whether an exact GoCD pipeline is paused, locked, and schedulable. The result excludes the pause reason and user identity.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      const response = await ctx.egress.fetch({
        operation: "gocd.pipeline.status",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(
            baseUrl,
            `/go/api/pipelines/${encodeURIComponent(input.pipeline)}/status`,
          ),
          {
            headers: { Accept: "application/vnd.go.cd.v1+json" },
            method: "GET",
          },
        ),
      });
      if (!response.ok) {
        throw new Error(
          `GoCD pipeline status failed with HTTP ${response.status}`,
        );
      }
      const body = bodySchema.parse(await response.json());
      return {
        target: "pipeline_status",
        baseUrl,
        pipeline: input.pipeline,
        paused: body.paused,
        locked: body.locked,
        schedulable: body.schedulable,
      };
    },
  });
}
