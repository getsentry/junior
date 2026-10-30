/**
 * Sentry org read access.
 *
 * An internal integration token can read the Sentry organization that
 * installed the integration. Junior uses it for Sentry API reads of that
 * organization. Reads of other organizations, writes, and `/api/0/users/`
 * requests use the requesting user's OAuth token.
 */
import { createHash } from "node:crypto";
import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginCache,
  PluginCredentialResult,
  PluginGrant,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const SENTRY_API_DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];

const ORG_READ_GRANT = "org-read";
const LEASE_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Path resources whose next segment is an organization slug.
const ORG_PATH_RESOURCES = new Set(["organizations", "projects", "teams"]);
const TOKEN_ORG_TTL_MS = 60 * 60 * 1000;

const tokenOrgsSchema = z.array(z.object({ id: z.string(), slug: z.string() }));

function orgReadToken(): string | undefined {
  return process.env.SENTRY_READ_TOKEN?.trim() || undefined;
}

// `/api/0/users/` requests stay on user OAuth because the token has no user.
function isOrgReadRequest(request: EgressHookContext["request"]): boolean {
  if (!READ_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  const url = new URL(request.url);
  if (!SENTRY_API_DOMAINS.includes(url.hostname)) {
    return false;
  }
  const [api, version, resource] = url.pathname.split("/").filter(Boolean);
  return api === "api" && version === "0" && !!resource && resource !== "users";
}

function requestOrg(url: string): string | undefined {
  const [, , resource, org] = new URL(url).pathname.split("/").filter(Boolean);
  return resource && ORG_PATH_RESOURCES.has(resource) ? org : undefined;
}

// The token can read only the organization that installed its integration.
// Sentry paths accept the organization ID or slug, so return both.
async function loadTokenOrg(
  cache: PluginCache,
  token: string,
): Promise<string[]> {
  const tokenId = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return await cache.getOrLoad(`org-read-org:${tokenId}`, async () => {
    const response = await fetch("https://sentry.io/api/0/organizations/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Sentry org read token organization lookup failed with HTTP ${response.status}.`,
      );
    }
    const orgs = tokenOrgsSchema.parse(await response.json());
    const [org] = orgs;
    if (!org || orgs.length > 1) {
      throw new Error(
        `Sentry org read token must see exactly one organization, but it sees ${orgs.length}.`,
      );
    }
    return { value: [org.id, org.slug], ttlMs: TOKEN_ORG_TTL_MS };
  });
}

/**
 * Select the org read grant for Sentry API reads of the token's organization.
 *
 * Return undefined for other requests so the host uses the user's OAuth token.
 */
export async function sentryGrantForEgress(
  ctx: EgressHookContext,
): Promise<PluginGrant | undefined> {
  const token = orgReadToken();
  if (!token || !isOrgReadRequest(ctx.request)) {
    return undefined;
  }
  const org = requestOrg(ctx.request.url);
  if (org && !(await loadTokenOrg(ctx.cache, token)).includes(org)) {
    return undefined;
  }
  return {
    name: ORG_READ_GRANT,
    access: "read",
    reason: "sentry.org-read",
  };
}

/** Issue the org read token for the org read grant. */
export function issueSentryCredential(
  ctx: IssueCredentialHookContext,
): PluginCredentialResult {
  if (ctx.grant.name !== ORG_READ_GRANT) {
    throw new Error(
      `Sentry plugin cannot issue unknown grant "${ctx.grant.name}".`,
    );
  }
  const token = orgReadToken();
  if (!token) {
    return {
      type: "unavailable",
      message: "Sentry org read access requires SENTRY_READ_TOKEN.",
    };
  }
  return {
    type: "lease",
    lease: {
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      headerTransforms: SENTRY_API_DOMAINS.map((domain) => ({
        domain,
        headers: { Authorization: `Bearer ${token}` },
      })),
    },
  };
}
