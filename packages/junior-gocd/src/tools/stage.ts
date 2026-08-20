import {
  definePluginTool,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  resolveGocdApiUrl,
  resolveGocdTarget,
  stageRunInputShape,
  stageRunPath,
  type GocdPluginOptions,
} from "../config.js";

const inputSchema = z.object(stageRunInputShape).strict();

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
    jobs: z.array(jobSchema).default([]),
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

/**
 * Return one exact GoCD stage run: its result, jobs, failed job names, and a
 * stable UI link. Uses GoCD 25.2.0 `GET /go/api/stages/...` with Accept v3.
 * Auth headers are injected by the runtime, not read in this tool.
 */
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
      "Fetch one exact GoCD stage run (result, jobs, and failed job names) with a stable link. Identify the run with pipeline name, pipeline counter, stage name, and stage counter. Auth is injected at egress from host-managed credentials.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const target = resolveGocdTarget({ baseUrl: input.baseUrl, options });
      const runPath = stageRunPath(input);
      const response = await ctx.egress.fetch({
        operation: "gocd.stage",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(target.baseUrl, `/go/api/stages/${runPath}`),
          {
            headers: { Accept: "application/vnd.go.cd.v3+json" },
            method: "GET",
          },
        ),
      });
      if (!response.ok) {
        throw new Error(`GoCD stage failed with HTTP ${response.status}`);
      }
      const body = stageBodySchema.parse(await response.json());
      const jobs: Job[] = body.jobs.map((job) => ({
        name: job.name,
        result: job.result ?? "Unknown",
        state: job.state ?? "Unknown",
      }));
      const link = resolveGocdApiUrl(
        target.baseUrl,
        `/go/pipelines/${runPath}`,
      );
      return {
        target: "stage",
        baseUrl: target.baseUrl,
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
