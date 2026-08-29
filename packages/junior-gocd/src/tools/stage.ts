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
    pipelineCounter: z
      .number()
      .int()
      .min(1)
      .describe("Pipeline run counter (integer)."),
    stage: z.string().trim().min(1).describe("Exact stage name."),
    stageCounter: z
      .number()
      .int()
      .min(1)
      .describe("Stage run counter (integer)."),
  })
  .strict();

const jobSchema = z
  .object({
    name: z.string(),
    result: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const stageBodySchema = z
  .object({
    result: z.string().optional(),
    _embedded: z.object({ jobs: z.array(jobSchema).default([]) }),
  })
  .passthrough();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("stage"),
  baseUrl: z.string(),
  link: z.string(),
  pipeline: z.string(),
  pipelineCounter: z.number(),
  stage: z.string(),
  stageCounter: z.number(),
  result: z.string(),
  jobs: z.array(
    z.object({ name: z.string(), result: z.string(), state: z.string() }),
  ),
  failedJobs: z.array(z.string()),
});

interface Job {
  name: string;
  result: string;
  state: string;
}

interface Result extends PluginToolOutput {
  target: "stage";
  baseUrl: string;
  link: string;
  pipeline: string;
  pipelineCounter: number;
  stage: string;
  stageCounter: number;
  result: string;
  jobs: Job[];
  failedJobs: string[];
}

/** Return one exact GoCD stage run and its jobs. */
export function createGocdStageTool(
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
      "Fetch one exact GoCD stage run, its jobs, and failed job names. Identify the run with its pipeline name, pipeline counter, stage name, and stage counter.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      const path =
        `/go/api/stages/${encodeURIComponent(input.pipeline)}` +
        `/${encodeURIComponent(input.stage)}/instance` +
        `/${input.pipelineCounter}/${input.stageCounter}`;
      const response = await ctx.egress.fetch({
        operation: "gocd.stage",
        provider: "gocd",
        request: new Request(resolveGocdApiUrl(baseUrl, path), {
          headers: { Accept: "application/vnd.go.cd.v3+json" },
          method: "GET",
        }),
      });
      if (!response.ok) {
        throw new Error(`GoCD stage failed with HTTP ${response.status}`);
      }
      const body = stageBodySchema.parse(await response.json());
      const jobs: Job[] = body._embedded.jobs.map((job) => ({
        name: job.name,
        result: job.result ?? "Unknown",
        state: job.state ?? "Unknown",
      }));
      const link = resolveGocdApiUrl(
        baseUrl,
        `/go/pipelines/${encodeURIComponent(input.pipeline)}` +
          `/${input.pipelineCounter}/${encodeURIComponent(input.stage)}` +
          `/${input.stageCounter}`,
      );
      return {
        target: "stage",
        baseUrl,
        link,
        pipeline: input.pipeline,
        pipelineCounter: input.pipelineCounter,
        stage: input.stage,
        stageCounter: input.stageCounter,
        result: body.result ?? "Unknown",
        jobs,
        failedJobs: jobs
          .filter((job) => job.result === "Failed")
          .map((job) => job.name),
      };
    },
  });
}
