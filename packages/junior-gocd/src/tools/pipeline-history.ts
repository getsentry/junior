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
    count: z.number().int().min(1).max(100).default(20),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("pipeline_history"),
  baseUrl: z.string(),
  pipeline: z.string(),
  runs: z.array(z.unknown()),
});

interface Result extends PluginToolOutput {
  target: "pipeline_history";
  baseUrl: string;
  pipeline: string;
  runs: unknown[];
}

/**
 * Return recent runs for one GoCD pipeline.
 *
 * Uses GoCD 25.2.0 `GET /go/api/pipelines/:name/history` with Accept v1.
 * `page_size` must stay in 10..100. Smaller counts are clamped, then sliced.
 */
export function createGocdPipelineHistoryTool(
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
      "Fetch recent runs for an exact GoCD pipeline. Use this to inspect deployment history and stage or job results.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      // GoCD 25.2.0 rejects page_size outside 10..100 with HTTP 404.
      const pageSize = Math.min(100, Math.max(10, input.count));
      const response = await ctx.egress.fetch({
        operation: "gocd.pipeline.history",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(
            baseUrl,
            `/go/api/pipelines/${encodeURIComponent(input.pipeline)}/history?page_size=${pageSize}`,
          ),
          {
            headers: {
              Accept: "application/vnd.go.cd.v1+json",
            },
            method: "GET",
          },
        ),
      });
      if (!response.ok) {
        throw new Error(
          `GoCD pipeline history failed with HTTP ${response.status}`,
        );
      }
      const body = z
        .object({ pipelines: z.array(z.unknown()) })
        .passthrough()
        .parse(await response.json());
      return {
        baseUrl,
        pipeline: input.pipeline,
        runs: body.pipelines.slice(0, input.count),
        target: "pipeline_history",
      };
    },
  });
}
