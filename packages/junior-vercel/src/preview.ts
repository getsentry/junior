import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { z } from "zod";

export const vercelPreviewOptionsSchema = z
  .object({
    teamId: z.string().regex(/^team_[a-zA-Z0-9]+$/),
    projectId: z.string().regex(/^prj_[a-zA-Z0-9]+$/),
    repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    alias: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),
  })
  .strict();

/** Host-owned scope for opt-in Preview actions; never a conversation default. */
export type VercelPreviewOptions = z.infer<typeof vercelPreviewOptionsSchema>;

export const previewCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const previewDeploymentIdSchema = z.string().regex(/^dpl_[a-zA-Z0-9]+$/);

const previewDeploymentSchema = z.object({
  id: previewDeploymentIdSchema,
  projectId: z.string(),
  target: z.string().nullable(),
  readyState: z.string(),
  customEnvironment: z.unknown().optional(),
  gitSource: z
    .object({
      type: z.literal("github"),
      sha: previewCommitSchema,
    })
    .passthrough(),
});

/** Build Vercel URLs with an explicit team and no caller-controlled query. */
export function vercelPreviewUrl(
  scope: VercelPreviewOptions,
  path: string,
): string {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", scope.teamId);
  return url.toString();
}

/** Keep provider payloads, which can contain credentials, out of tool results. */
export async function readVercelPreviewResponse(
  response: Response,
): Promise<unknown> {
  if (!response.ok) {
    const message = `Vercel Preview request failed with HTTP ${response.status}`;
    if (response.status === 404) throw new PluginToolInputError(message);
    throw new Error(message);
  }
  return response.json();
}

/** Require a Preview from the configured project and the exact requested commit. */
export function parseVercelPreview(
  data: unknown,
  scope: VercelPreviewOptions,
  commitSha: string,
) {
  const deployment = previewDeploymentSchema.parse(data);
  if (
    deployment.customEnvironment != null ||
    deployment.projectId !== scope.projectId ||
    ![null, "preview"].includes(deployment.target) ||
    deployment.gitSource.sha !== commitSha
  ) {
    throw new PluginToolInputError(
      "Deployment does not match the configured Preview project and commit.",
    );
  }
  return deployment;
}
