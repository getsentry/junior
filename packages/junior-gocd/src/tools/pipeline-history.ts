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

const jobSchema = z
  .object({
    name: z.string(),
    result: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const stageSchema = z
  .object({
    name: z.string(),
    counter: z.union([z.string(), z.number()]),
    result: z.string().optional(),
    status: z.string().optional(),
    jobs: z.array(jobSchema).default([]),
  })
  .passthrough();

const runSchema = z
  .object({
    name: z.string(),
    counter: z.number(),
    label: z.string().optional(),
    scheduled_date: z.number().nullable().optional(),
    stages: z.array(stageSchema).default([]),
  })
  .passthrough();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("pipeline_history"),
  baseUrl: z.string(),
  pipeline: z.string(),
  runs: z.array(
    z.object({
      counter: z.number(),
      label: z.string(),
      scheduledAt: z.number().nullable(),
      stages: z.array(
        z.object({
          name: z.string(),
          counter: z.string(),
          result: z.string(),
          status: z.string(),
          jobs: z.array(
            z.object({
              name: z.string(),
              result: z.string(),
              state: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});

type Result = PluginToolOutput & z.infer<typeof outputSchema>;

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
      "Fetch recent runs for an exact GoCD pipeline with stage and job results. The result excludes source material, commit messages, user identities, and environment variables.",
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
        .object({ pipelines: z.array(runSchema) })
        .passthrough()
        .parse(await response.json());
      return {
        baseUrl,
        pipeline: input.pipeline,
        runs: body.pipelines.slice(0, input.count).map((run) => ({
          counter: run.counter,
          label: run.label ?? String(run.counter),
          scheduledAt: run.scheduled_date ?? null,
          stages: run.stages.map((stage) => ({
            name: stage.name,
            counter: String(stage.counter),
            result: stage.result ?? "Unknown",
            status: stage.status ?? "Unknown",
            jobs: stage.jobs.map((job) => ({
              name: job.name,
              result: job.result ?? "Unknown",
              state: job.state ?? "Unknown",
            })),
          })),
        })),
        target: "pipeline_history",
      };
    },
  });
}
