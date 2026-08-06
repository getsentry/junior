import {
  definePluginTool,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { vercelDeploymentSourceSubscribable } from "../resource-events/deployment-source.js";
import { vercelWebhookSecret } from "../webhooks/secret.js";

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9]+$/);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const targetSchema = z.enum(["preview", "production", "staging"]);
const nonEmptyStringSchema = z.string().trim().min(1);

const inputSchema = z
  .object({
    commitSha: commitShaSchema
      .describe(
        "Optional full 40-character Git commit SHA. Provide it to watch one deployment; omit it to watch every matching deployment for the project.",
      )
      .optional(),
    project: nonEmptyStringSchema.describe("Vercel project name or prj_ ID."),
    target: targetSchema
      .describe(
        'Optional deployment target such as "production". Omit to watch every target for the project. Required with commitSha so the commit watch stays target-scoped.',
      )
      .optional(),
    team: nonEmptyStringSchema
      .describe("Optional Vercel team slug or team_ ID that owns the project.")
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.commitSha && !input.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'target is required when commitSha is set. Use "production", "preview", or "staging".',
        path: ["target"],
      });
    }
  });

const deploymentSourceSchema = z.object({
  commitSha: commitShaSchema.nullable(),
  deploymentTarget: targetSchema.nullable(),
  projectId: projectIdSchema,
  subscribable: subscribableResourceSchema.optional(),
});

type DeploymentSource = z.output<typeof deploymentSourceSchema>;

interface Result extends PluginToolOutput, DeploymentSource {
  target: "deploymentSource";
}

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("deploymentSource"),
  ...deploymentSourceSchema.shape,
});

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function projectLookupUrl(project: string, team?: string): string {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}`,
  );
  if (team) {
    url.searchParams.set(team.startsWith("team_") ? "teamId" : "slug", team);
  }
  return url.toString();
}

/** Resolve and return the resource identity for one Vercel deployment source. */
export function createVercelDeploymentSourceTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Resolve a Vercel project name or ID and describe a subscribable deployment source. Omit commitSha to watch every deployment for the project, optionally limited to one target (production, preview, or staging). Provide commitSha and target together to watch one deployment. Use the user's explicit project and team, otherwise the vercel.project and vercel.team conversation defaults.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const response = await ctx.egress.fetch({
        operation: "vercel.project.get",
        provider: "vercel",
        request: new Request(projectLookupUrl(input.project, input.team)),
      });
      const parsed = await readJson(response);
      if (!response.ok) {
        throw new Error(
          `Vercel project lookup failed with HTTP ${response.status}`,
        );
      }
      const projectId = z.object({ id: projectIdSchema }).parse(parsed).id;
      const commitSha = input.commitSha?.toLowerCase();
      const deploymentTarget = input.target;
      const subscribable = ctx.resourceEvents.canSubscribe
        ? vercelDeploymentSourceSubscribable({
            commitSha,
            projectId,
            target: deploymentTarget,
            webhookSecret: vercelWebhookSecret(),
          })
        : undefined;
      const data: DeploymentSource = {
        commitSha: commitSha ?? null,
        deploymentTarget: deploymentTarget ?? null,
        projectId,
        ...(subscribable ? { subscribable } : {}),
      };
      return {
        target: "deploymentSource",
        ...data,
      };
    },
  });
}
