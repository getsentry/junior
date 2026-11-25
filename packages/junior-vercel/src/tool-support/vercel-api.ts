/**
 * Vercel API calls and shared shapes of the deployment and alias tools. The
 * tools return selected fields because Vercel responses can contain
 * environment credentials.
 */
import {
  PluginToolInputError,
  pluginToolOutputSchema,
  type AnnotatedObject,
  type PluginEgress,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { VERCEL_SUBJECT_KINDS } from "../inbox-subjects.js";

/** Text with at least one character after trimming. */
export const nonEmptyText = z.string().trim().min(1);
/** Optional Vercel team scope of a request. */
export const teamSchema = nonEmptyText
  .describe(
    "Vercel team slug or team_ ID. Omit for the token's default account.",
  )
  .optional();
/** Exact Vercel deployment ID. */
export const deploymentIdSchema = z
  .string()
  .regex(/^dpl_[a-zA-Z0-9]+$/)
  .describe("Exact Vercel deployment ID, not an alias.");
/** Alias hostname of a deployment. */
export const aliasNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/)
  .describe("Alias hostname without a scheme or path.");
const deploymentSchema = z.object({
  id: nonEmptyText,
  url: nonEmptyText,
  readyState: nonEmptyText,
  target: z.string().nullable().optional(),
  projectId: nonEmptyText.optional(),
  gitSource: z
    .object({ sha: nonEmptyText.optional(), ref: nonEmptyText.optional() })
    .nullable()
    .optional(),
});
/** Output of the tools that return one deployment. */
export const deploymentOutputSchema = pluginToolOutputSchema.extend({
  target: z.literal("deployment"),
  deployment_id: nonEmptyText,
  url: nonEmptyText,
  state: nonEmptyText,
  deployment_target: z.string().nullable(),
  project_id: nonEmptyText.nullable(),
  commit_sha: nonEmptyText.nullable(),
  ref: nonEmptyText.nullable(),
});
const aliasSchema = z.object({
  alias: nonEmptyText,
  deploymentId: nonEmptyText.nullable(),
  redirect: nonEmptyText.nullable().optional(),
});
/** Output of the tools that return one alias. */
export const aliasOutputSchema = pluginToolOutputSchema.extend({
  target: z.literal("alias"),
  alias: nonEmptyText,
  deployment_id: nonEmptyText.nullable(),
  redirect: nonEmptyText.nullable(),
});

/**
 * Select the safe fields of a Vercel deployment for a tool result. A tool
 * that created the deployment passes `created`, so the result saves its
 * Annotation. A read adds none.
 */
export function deploymentResult(data: unknown, action?: "created") {
  const value = deploymentSchema.parse(data);
  const annotation: AnnotatedObject | undefined = action && {
    action,
    kind: "object",
    objectType: "deployment",
    displayType: "Deployment",
    key: value.id,
    subject: { id: value.id, kind: VERCEL_SUBJECT_KINDS.deployment },
    label: value.id,
    title: value.url.slice(0, 512),
    url: `https://${value.url}`,
    status: value.readyState,
    facts: {
      type: "deployment",
      project: value.projectId?.slice(0, 64),
      environment: value.target?.slice(0, 64) ?? undefined,
      revision: value.gitSource?.sha?.slice(0, 64),
      branch: value.gitSource?.ref?.slice(0, 64),
    },
  };
  return {
    target: "deployment" as const,
    deployment_id: value.id,
    url: `https://${value.url}`,
    state: value.readyState,
    deployment_target: value.target ?? null,
    project_id: value.projectId ?? null,
    commit_sha: value.gitSource?.sha ?? null,
    ref: value.gitSource?.ref ?? null,
    ...(annotation ? { objectAnnotations: [annotation] } : undefined),
  };
}

/** Call the Vercel API through plugin egress and return the JSON body. */
export async function vercelRequest(
  egress: PluginEgress,
  operation: string,
  path: string,
  scope?: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const url = new URL(path, "https://api.vercel.com");
  if (scope)
    url.searchParams.set(scope.startsWith("team_") ? "teamId" : "slug", scope);
  const init: RequestInit = {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await egress.fetch({
    provider: "vercel",
    operation,
    request: new Request(url, init),
  });
  if (!response.ok) {
    const message = `${operation} failed with HTTP ${response.status}`;
    if (response.status === 400 || response.status === 404)
      throw new PluginToolInputError(
        `${message}. Check the ids and names in the arguments.`,
      );
    throw new Error(message);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

/** Read one Vercel alias and select its safe fields. */
export async function inspectAlias(
  egress: PluginEgress,
  alias: string,
  scope?: string,
) {
  const result = aliasSchema.parse(
    await vercelRequest(
      egress,
      "vercel.alias.get",
      `/v4/aliases/${encodeURIComponent(alias)}`,
      scope,
    ),
  );
  return {
    target: "alias" as const,
    alias: result.alias,
    deployment_id: result.deploymentId,
    redirect: result.redirect ?? null,
  };
}
