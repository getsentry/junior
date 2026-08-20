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
import { dedupeConsecutive, redactSecrets, tailLines } from "../log.js";

const inputSchema = z
  .object({
    ...stageRunInputShape,
    job: z.string().trim().min(1).describe("Exact job name."),
    tail: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(200)
      .describe("Return only the last N lines of console output."),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("jobLog"),
  baseUrl: z.string(),
  link: z.string(),
  pipeline: z.string(),
  pipelineCounter: z.number(),
  stage: z.string(),
  stageCounter: z.number(),
  job: z.string(),
  available: z.boolean(),
  log: z.string(),
  totalLines: z.number(),
  returnedLines: z.number(),
  truncated: z.boolean(),
  deduped: z.boolean(),
  note: z.string(),
});

interface Result extends PluginToolOutput {
  target: "jobLog";
  baseUrl: string;
  link: string;
  pipeline: string;
  pipelineCounter: number;
  stage: string;
  stageCounter: number;
  job: string;
  available: boolean;
  log: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  deduped: boolean;
  note: string;
}

/**
 * Return bounded, de-duplicated, secret-redacted console output for one exact
 * GoCD job. Reads the text `.../cruise-output/console.log` endpoint. An expired
 * or missing log returns `available: false` instead of throwing.
 * Auth headers are injected by the runtime, not read in this tool.
 */
export function createGocdJobLogTool(
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
      "Fetch the console log for one exact GoCD job, tailed and de-duplicated, with secrets redacted and a stable link. Identify the job with pipeline name, pipeline counter, stage name, stage counter, and job name. Expired logs return available=false. Auth is injected at egress from host-managed credentials.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const target = resolveGocdTarget({ baseUrl: input.baseUrl, options });
      const runPath = `${stageRunPath(input)}/${encodeURIComponent(input.job)}`;
      const link = resolveGocdApiUrl(
        target.baseUrl,
        `/go/tab/build/detail/${runPath}`,
      );
      const base = {
        target: "jobLog" as const,
        baseUrl: target.baseUrl,
        link,
        pipeline: input.pipeline,
        pipelineCounter: input.pipelineCounter,
        stage: input.stage,
        stageCounter: input.stageCounter,
        job: input.job,
      };

      const response = await ctx.egress.fetch({
        operation: "gocd.job.log",
        provider: "gocd",
        request: new Request(
          resolveGocdApiUrl(
            target.baseUrl,
            `/go/files/${runPath}/cruise-output/console.log`,
          ),
          { headers: { Accept: "text/plain" }, method: "GET" },
        ),
      });

      if (response.status === 404) {
        return {
          ...base,
          available: false,
          log: "",
          totalLines: 0,
          returnedLines: 0,
          truncated: false,
          deduped: false,
          note: "Console log is unavailable or expired for this job.",
        };
      }
      if (!response.ok) {
        throw new Error(`GoCD job log failed with HTTP ${response.status}`);
      }

      const text = await response.text();
      const rawLines = text.length ? text.replace(/\n$/, "").split("\n") : [];
      const { lines: dedupedLines, deduped } = dedupeConsecutive(rawLines);
      const { lines: tailed, truncated } = tailLines(dedupedLines, input.tail);
      return {
        ...base,
        available: true,
        log: redactSecrets(tailed.join("\n")),
        totalLines: dedupedLines.length,
        returnedLines: tailed.length,
        truncated,
        deduped,
        note: "",
      };
    },
  });
}
