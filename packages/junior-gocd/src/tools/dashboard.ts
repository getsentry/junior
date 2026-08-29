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

const stageSchema = z
  .object({
    name: z.string(),
    counter: z.union([z.string(), z.number()]),
    status: z.string(),
    scheduled_at: z.string().nullable().optional(),
  })
  .passthrough();

const instanceSchema = z
  .object({
    label: z.string(),
    counter: z.number(),
    scheduled_at: z.string().nullable().optional(),
    _embedded: z.object({ stages: z.array(stageSchema).default([]) }),
  })
  .passthrough();

const pipelineSchema = z
  .object({
    name: z.string(),
    last_updated_timestamp: z.number().nullable().optional(),
    locked: z.boolean(),
    pause_info: z.object({ paused: z.boolean() }),
    from_config_repo: z.boolean(),
    _embedded: z.object({ instances: z.array(instanceSchema).default([]) }),
  })
  .passthrough();

const namedPipelineListSchema = z
  .object({ name: z.string(), pipelines: z.array(z.string()).default([]) })
  .passthrough();

const dashboardSchema = z.object({
  _embedded: z.object({
    pipelines: z.array(pipelineSchema).default([]),
    environments: z.array(namedPipelineListSchema).default([]),
    pipeline_groups: z.array(namedPipelineListSchema).default([]),
  }),
});

const stageOutputSchema = z.object({
  name: z.string(),
  counter: z.string(),
  status: z.string(),
  scheduledAt: z.string().nullable(),
});

const instanceOutputSchema = z.object({
  label: z.string(),
  counter: z.number(),
  scheduledAt: z.string().nullable(),
  stages: z.array(stageOutputSchema),
});

const inputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional case-insensitive pipeline name filter."),
    count: z.number().int().min(1).max(100).default(50),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("dashboard"),
  baseUrl: z.string(),
  pipelines: z.array(
    z.object({
      name: z.string(),
      lastUpdatedAt: z.number().nullable(),
      locked: z.boolean(),
      paused: z.boolean(),
      fromConfigRepo: z.boolean(),
      instances: z.array(instanceOutputSchema),
    }),
  ),
  environments: z.array(
    namedPipelineListSchema.pick({ name: true, pipelines: true }),
  ),
  pipelineGroups: z.array(
    namedPipelineListSchema.pick({ name: true, pipelines: true }),
  ),
});

type Result = PluginToolOutput & z.infer<typeof outputSchema>;

/** Return the pipelines visible to the current GoCD user with recent run state. */
export function createGocdDashboardTool(
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
      "Search visible GoCD pipelines and return their groups, environments, and recent run state. Use this to discover exact pipeline names. The result excludes user identities, permissions, and pause reasons.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const baseUrl = resolveGocdBaseUrl(options);
      const response = await ctx.egress.fetch({
        operation: "gocd.dashboard",
        provider: "gocd",
        request: new Request(resolveGocdApiUrl(baseUrl, "/go/api/dashboard"), {
          headers: { Accept: "application/vnd.go.cd.v4+json" },
          method: "GET",
        }),
      });
      if (!response.ok) {
        throw new Error(`GoCD dashboard failed with HTTP ${response.status}`);
      }
      const body = dashboardSchema.parse(await response.json())._embedded;
      const query = input.query?.toLocaleLowerCase();
      const pipelines = body.pipelines
        .filter(
          (pipeline) =>
            !query || pipeline.name.toLocaleLowerCase().includes(query),
        )
        .slice(0, input.count);
      const pipelineNames = new Set(pipelines.map((pipeline) => pipeline.name));
      return {
        target: "dashboard",
        baseUrl,
        pipelines: pipelines.map((pipeline) => ({
          name: pipeline.name,
          lastUpdatedAt: pipeline.last_updated_timestamp ?? null,
          locked: pipeline.locked,
          paused: pipeline.pause_info.paused,
          fromConfigRepo: pipeline.from_config_repo,
          instances: pipeline._embedded.instances.map((instance) => ({
            label: instance.label,
            counter: instance.counter,
            scheduledAt: instance.scheduled_at ?? null,
            stages: instance._embedded.stages.map((stage) => ({
              name: stage.name,
              counter: String(stage.counter),
              status: stage.status,
              scheduledAt: stage.scheduled_at ?? null,
            })),
          })),
        })),
        environments: body.environments
          .map(({ name, pipelines }) => ({
            name,
            pipelines: pipelines.filter((pipeline) =>
              pipelineNames.has(pipeline),
            ),
          }))
          .filter(({ pipelines }) => pipelines.length > 0),
        pipelineGroups: body.pipeline_groups
          .map(({ name, pipelines }) => ({
            name,
            pipelines: pipelines.filter((pipeline) =>
              pipelineNames.has(pipeline),
            ),
          }))
          .filter(({ pipelines }) => pipelines.length > 0),
      };
    },
  });
}
