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
import { throwGocdReadError } from "../errors.js";

const inputSchema = z
  .object({
    pipeline: z.string().trim().min(1).describe("Exact GoCD pipeline name."),
    pipelineCounter: z
      .number()
      .int()
      .min(1)
      .describe("GoCD counter for the pipeline run."),
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
    scheduled: z.boolean().optional(),
    jobs: z.array(jobSchema).default([]),
  })
  .passthrough();

const bodySchema = z
  .object({
    name: z.string(),
    counter: z.number(),
    label: z.string(),
    scheduled_date: z.number().nullable().optional(),
    stages: z.array(stageSchema).default([]),
  })
  .passthrough();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("pipeline_run"),
  baseUrl: z.string(),
  pipeline: z.string(),
  pipelineCounter: z.number(),
  label: z.string(),
  scheduledAt: z.number().nullable(),
  stages: z.array(
    z.object({
      name: z.string(),
      counter: z.string(),
      result: z.string(),
      status: z.string(),
      scheduled: z.boolean(),
      jobs: z.array(
        z.object({ name: z.string(), result: z.string(), state: z.string() }),
      ),
    }),
  ),
});

type Result = PluginToolOutput & z.infer<typeof outputSchema>;

/** Return the operational state for one exact GoCD pipeline run. */
export function createGocdPipelineRunTool(
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
      "Fetch one exact GoCD pipeline run with stage and job results. The result excludes source material, commit messages, user identities, and environment variables.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      // GoCD 25.2 calls this a pipeline instance, but its v1 route has no /instance segment.
      const response = await ctx.egress.fetch({
        operation: "gocd.pipeline.run",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(
            baseUrl,
            `/go/api/pipelines/${encodeURIComponent(input.pipeline)}/${input.pipelineCounter}`,
          ),
          {
            headers: { Accept: "application/vnd.go.cd.v1+json" },
            method: "GET",
          },
        ),
      });
      if (!response.ok) {
        throwGocdReadError(
          `GoCD pipeline run failed with HTTP ${response.status}`,
          response.status,
          { missingResourceIsInput: true },
        );
      }
      const body = bodySchema.parse(await response.json());
      return {
        target: "pipeline_run",
        baseUrl,
        pipeline: body.name,
        pipelineCounter: body.counter,
        label: body.label,
        scheduledAt: body.scheduled_date ?? null,
        stages: body.stages.map((stage) => ({
          name: stage.name,
          counter: String(stage.counter),
          result: stage.result ?? "Unknown",
          status: stage.status ?? "Unknown",
          scheduled: stage.scheduled ?? false,
          jobs: stage.jobs.map((job) => ({
            name: job.name,
            result: job.result ?? "Unknown",
            state: job.state ?? "Unknown",
          })),
        })),
      };
    },
  });
}
