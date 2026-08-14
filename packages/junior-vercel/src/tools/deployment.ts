import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { vercelProjectIdSchema } from "../project.js";
import { vercelDeploymentSubscribable } from "../resource-events/deployment.js";
import { vercelWebhookSecret } from "../webhooks/secret.js";

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
        'Optional deployment target such as "production". Omit to watch every target for the project. Defaults to "production" when commitSha is set.',
      )
      .optional(),
    team: nonEmptyStringSchema
      .describe("Optional Vercel team slug or team_ ID that owns the project.")
      .optional(),
  })
  .strict();

const deploymentSchema = z.object({
  commitSha: commitShaSchema.nullable(),
  deploymentTarget: targetSchema.nullable(),
  projectId: vercelProjectIdSchema,
  subscribable: subscribableResourceSchema.optional(),
});

type Deployment = z.output<typeof deploymentSchema>;

interface Result extends PluginToolOutput, Deployment {
  target: "deployment";
}

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("deployment"),
  ...deploymentSchema.shape,
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

/** Resolve and return the resource identity for one Vercel deployment. */
export function createVercelDeploymentTool(ctx: ToolRegistrationHookContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Resolve a Vercel project name or ID and describe a subscribable deployment resource. Omit commitSha to watch every deployment for the project, optionally limited to one target (production, preview, or staging). Provide commitSha to watch one deployment; target defaults to production when omitted with commitSha. Use the user's explicit project and team, otherwise the vercel.project and vercel.team conversation defaults.",
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
        throw new PluginToolInputError(
          `Vercel project lookup failed with HTTP ${response.status}`,
        );
      }
      const projectId = z
        .object({ id: vercelProjectIdSchema })
        .parse(parsed).id;
      const commitSha = input.commitSha?.toLowerCase();
      // Preserve the previous commit-watch default so one-shot SHA watches stay
      // production-scoped unless the caller names another target.
      const deploymentTarget =
        input.target ?? (commitSha ? ("production" as const) : undefined);
      const subscribable = ctx.resourceEvents.canSubscribe
        ? vercelDeploymentSubscribable({
            commitSha,
            projectId,
            target: deploymentTarget,
            webhookSecret: vercelWebhookSecret(),
          })
        : undefined;
      const data: Deployment = {
        commitSha: commitSha ?? null,
        deploymentTarget: deploymentTarget ?? null,
        projectId,
        ...(subscribable ? { subscribable } : {}),
      };
      return {
        target: "deployment",
        ...data,
      };
    },
  });
}
