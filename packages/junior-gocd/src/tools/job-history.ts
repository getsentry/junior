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
    stage: z.string().trim().min(1).describe("Exact stage name."),
    job: z.string().trim().min(1).describe("Exact job name."),
    count: z.number().int().min(1).max(100).default(20),
  })
  .strict();

const jobSchema = z
  .object({
    name: z.string(),
    scheduled_date: z.number().nullable().optional(),
    pipeline_counter: z.number(),
    rerun: z.boolean(),
    result: z.string(),
    state: z.string(),
    stage_counter: z.union([z.string(), z.number()]),
  })
  .passthrough();

const bodySchema = z
  .object({ jobs: z.array(jobSchema).default([]) })
  .passthrough();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("job_history"),
  baseUrl: z.string(),
  pipeline: z.string(),
  stage: z.string(),
  job: z.string(),
  runs: z.array(
    z.object({
      pipelineCounter: z.number(),
      stageCounter: z.string(),
      scheduledAt: z.number().nullable(),
      rerun: z.boolean(),
      result: z.string(),
      state: z.string(),
    }),
  ),
});

type Result = PluginToolOutput & z.infer<typeof outputSchema>;

/** Return recent runs for one exact GoCD job. */
export function createGocdJobHistoryTool(
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
      "Fetch recent runs for an exact GoCD job. The result includes counters, timestamps, and results. It excludes agent identifiers and user identities.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      // GoCD 25.2 accepts page_size from 10 through 100 on job history requests.
      const pageSize = Math.min(100, Math.max(10, input.count));
      const response = await ctx.egress.fetch({
        operation: "gocd.job.history",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(
            baseUrl,
            `/go/api/jobs/${encodeURIComponent(input.pipeline)}` +
              `/${encodeURIComponent(input.stage)}` +
              `/${encodeURIComponent(input.job)}/history?page_size=${pageSize}`,
          ),
          {
            headers: { Accept: "application/vnd.go.cd.v1+json" },
            method: "GET",
          },
        ),
      });
      if (!response.ok) {
        throwGocdReadError(
          `GoCD job history failed with HTTP ${response.status}`,
          response.status,
          { missingResourceIsInput: true },
        );
      }
      const body = bodySchema.parse(await response.json());
      return {
        target: "job_history",
        baseUrl,
        pipeline: input.pipeline,
        stage: input.stage,
        job: input.job,
        runs: body.jobs.slice(0, input.count).map((run) => ({
          pipelineCounter: run.pipeline_counter,
          stageCounter: String(run.stage_counter),
          scheduledAt: run.scheduled_date ?? null,
          rerun: run.rerun,
          result: run.result,
          state: run.state,
        })),
      };
    },
  });
}
