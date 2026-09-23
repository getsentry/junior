import {
  EgressPolicyDenied,
  type PluginCredentialResult,
  type PluginEgressRequest,
  type PluginGrant,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  previewCommitSchema,
  previewDeploymentIdSchema,
  parseVercelPreview,
  readVercelPreviewResponse,
  vercelPreviewUrl,
  type VercelPreviewOptions,
} from "./preview.js";

const writeGrant = "preview-write";
const readGrant = "read";
const deployBodySchema = z
  .object({
    name: z.string().min(1),
    project: z.string(),
    target: z.literal("preview"),
    gitSource: z
      .object({
        type: z.literal("github"),
        org: z.string(),
        repo: z.string(),
        ref: previewCommitSchema,
        sha: previewCommitSchema,
      })
      .strict(),
  })
  .strict();
const aliasBodySchema = z.object({ alias: z.string() }).strict();

/** Read scope evidence on the host before issuing a write credential. */
export async function readVercelScope(
  scope: VercelPreviewOptions,
  path: string,
): Promise<unknown> {
  const token = process.env.JUNIOR_VERCEL_TOKEN?.trim();
  if (!token)
    throw new Error("JUNIOR_VERCEL_TOKEN is required to verify Preview scope.");
  const response = await fetch(vercelPreviewUrl(scope, path), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return readVercelPreviewResponse(response);
}

/** Verify the configured project is still linked to the allowed repository. */
export async function readVercelPreviewProject(scope: VercelPreviewOptions) {
  const project = z
    .object({
      id: z.string(),
      name: z.string(),
      link: z.object({
        type: z.literal("github"),
        org: z.string(),
        repo: z.string(),
        repoId: z.union([z.string(), z.number()]),
      }),
    })
    .parse(await readVercelScope(scope, `/v9/projects/${scope.projectId}`));
  if (
    project.id !== scope.projectId ||
    `${project.link.org}/${project.link.repo}` !== scope.repository
  ) {
    throw new EgressPolicyDenied(
      "Vercel project is not linked to the configured Preview repository.",
    );
  }
  return project;
}

/** Check provider-owned scope before any Preview write, including host tool calls. */
export async function vercelGrantForEgress(
  request: PluginEgressRequest,
  scope?: VercelPreviewOptions,
): Promise<PluginGrant> {
  const url = new URL(request.url);
  if (url.origin !== "https://api.vercel.com" || url.username || url.password) {
    throw new EgressPolicyDenied(
      "Vercel credentials only apply to api.vercel.com.",
    );
  }
  if (["GET", "HEAD"].includes(request.method)) {
    return { name: readGrant, access: "read" };
  }
  if (!scope || !request.operation?.startsWith("vercel.preview.")) {
    throw new EgressPolicyDenied(
      "Vercel writes require configured Preview tools; raw CLI writes are disabled.",
    );
  }
  if (
    url.searchParams.size !== 1 ||
    url.searchParams.get("teamId") !== scope.teamId
  ) {
    throw new EgressPolicyDenied(
      "Vercel Preview writes require the configured team.",
    );
  }
  let body: unknown;
  if (request.bodyText) {
    try {
      body = JSON.parse(request.bodyText);
    } catch {
      throw new EgressPolicyDenied(
        "Vercel Preview write body must be complete JSON.",
      );
    }
  }
  const project = await readVercelPreviewProject(scope);
  if (
    request.operation === "vercel.preview.create" &&
    request.method === "POST" &&
    url.pathname === "/v13/deployments"
  ) {
    const parsed = deployBodySchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.project !== scope.projectId ||
      parsed.data.name !== project.name ||
      `${parsed.data.gitSource.org}/${parsed.data.gitSource.repo}` !==
        scope.repository ||
      parsed.data.gitSource.ref !== parsed.data.gitSource.sha
    ) {
      throw new EgressPolicyDenied(
        "Only an exact-commit Preview without setting or environment overrides is allowed.",
      );
    }
  } else {
    const match = url.pathname.match(
      /^\/v(2|13)\/deployments\/(dpl_[a-zA-Z0-9]+)(\/aliases)?$/,
    );
    const selecting =
      request.operation === "vercel.preview.select" &&
      request.method === "POST" &&
      match?.[1] === "2" &&
      match[3] === "/aliases";
    const deleting =
      request.operation === "vercel.preview.delete" &&
      request.method === "DELETE" &&
      match?.[1] === "13" &&
      !match[3];
    if (!match || (!selecting && !deleting))
      throw new EgressPolicyDenied(
        "Vercel write route is outside Preview scope.",
      );
    const parsedBody = aliasBodySchema.safeParse(body);
    if (
      (selecting &&
        (!parsedBody.success || parsedBody.data.alias !== scope.alias)) ||
      (deleting && body !== undefined)
    ) {
      throw new EgressPolicyDenied(
        "Only the configured Preview alias or a body-free Preview deletion is allowed.",
      );
    }
    const deploymentId = previewDeploymentIdSchema.parse(match[2]);
    const data = await readVercelScope(
      scope,
      `/v13/deployments/${deploymentId}?withGitRepoInfo=true`,
    );
    const source = z
      .object({
        gitSource: z.object({
          sha: previewCommitSchema,
          repoId: z.union([z.string(), z.number()]),
        }),
      })
      .parse(data);
    const deployment = parseVercelPreview(data, scope, source.gitSource.sha);
    if (
      String(source.gitSource.repoId) !== String(project.link.repoId) ||
      deployment.id !== deploymentId ||
      (selecting && deployment.readyState !== "READY")
    ) {
      throw new EgressPolicyDenied(
        "Vercel deployment is not an eligible Preview of the configured repository.",
      );
    }
  }
  return { name: writeGrant, access: "write", leaseScope: scope.projectId };
}

/** Issue separate host-only credentials for read requests and scoped Preview writes. */
export function issueVercelCredential(
  grant: PluginGrant,
  scope?: VercelPreviewOptions,
): PluginCredentialResult {
  const writing =
    grant.name === writeGrant &&
    grant.access === "write" &&
    scope &&
    grant.leaseScope === scope.projectId;
  if (!writing && !(grant.name === readGrant && grant.access === "read")) {
    throw new EgressPolicyDenied("Unknown Vercel credential grant.");
  }
  const env = writing ? "JUNIOR_VERCEL_PREVIEW_TOKEN" : "JUNIOR_VERCEL_TOKEN";
  const token = process.env[env]?.trim();
  if (!token)
    return { type: "unavailable", message: `${env} is not configured.` };
  return {
    type: "lease",
    lease: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      headerTransforms: [
        {
          domain: "api.vercel.com",
          headers: { Authorization: `Bearer ${token}` },
        },
      ],
    },
  };
}
