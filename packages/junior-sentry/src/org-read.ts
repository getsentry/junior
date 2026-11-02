/**
 * Sentry org read access.
 *
 * Junior reads Sentry orgs as itself, not as the requester. Each installation
 * of the public integration reads its own org, and the org in the API path
 * selects the installation. An internal integration token
 * (`SENTRY_READ_TOKEN`) can read only the org that created it. Junior uses it
 * for reads that no installation covers. Writes use the requesting user's
 * OAuth token.
 */
import {
  EgressPolicyDenied,
  type EgressHookContext,
  type IssueCredentialHookContext,
  type PluginCredentialResult,
  type PluginGrant,
} from "@sentry/junior-plugin-api";
import { activeSentryInstallations } from "./installations/store.js";
import {
  sentryAppConfig,
  sentryInstallationToken,
} from "./installations/tokens.js";

export const SENTRY_API_DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];

const ORG_READ_GRANT = "org-read";
const INSTALLATION_SCOPE_PREFIX = "installation:";
const LEASE_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function orgReadToken(): string | undefined {
  return process.env.SENTRY_READ_TOKEN?.trim() || undefined;
}

/** Path segments after `/api/0/`, or undefined for other Sentry requests. */
function apiPathSegments(
  request: EgressHookContext["request"],
): string[] | undefined {
  const url = new URL(request.url);
  if (!SENTRY_API_DOMAINS.includes(url.hostname)) {
    return undefined;
  }
  const [api, version, ...rest] = url.pathname.split("/").filter(Boolean);
  return api === "api" && version === "0" ? rest : undefined;
}

// `/api/0/users/` requests stay on user OAuth because Junior has no user.
function isOrgReadRequest(
  method: string,
  segments: string[] | undefined,
): segments is string[] {
  return (
    READ_METHODS.has(method.toUpperCase()) &&
    !!segments?.[0] &&
    segments[0] !== "users"
  );
}

/**
 * Read the org slug from an org-scoped API path. Paths such as
 * `/api/0/issues/{id}/` and the org list name no org.
 */
function orgFromApiPath(segments: string[]): string | undefined {
  const [resource, org] = segments;
  return (resource === "organizations" ||
    resource === "projects" ||
    resource === "teams") &&
    org
    ? org.toLowerCase()
    : undefined;
}

/**
 * Select the org read grant for Sentry API reads.
 *
 * Return undefined for other requests, and for reads when no installation or
 * org read token is configured, so the host uses the user's OAuth token.
 */
export async function sentryGrantForEgress(
  ctx: EgressHookContext,
): Promise<PluginGrant | undefined> {
  const segments = apiPathSegments(ctx.request);
  if (!isOrgReadRequest(ctx.request.method, segments)) {
    return undefined;
  }
  const grant: PluginGrant = {
    name: ORG_READ_GRANT,
    access: "read",
    reason: "sentry.org-read",
  };
  const installations = sentryAppConfig()
    ? await activeSentryInstallations(ctx)
    : [];
  const org = orgFromApiPath(segments);
  const internalToken = orgReadToken();
  const installation = org
    ? installations.find((candidate) => candidate.orgSlug === org)
    : !internalToken && installations.length === 1
      ? installations[0]
      : undefined;
  if (installation) {
    return {
      ...grant,
      leaseScope: `${INSTALLATION_SCOPE_PREFIX}${installation.installationUuid}`,
    };
  }
  if (internalToken) {
    return grant;
  }
  if (installations.length === 0) {
    return undefined;
  }
  throw new EgressPolicyDenied(
    org
      ? `Junior is not installed in the Sentry org "${org}". An owner of that org must install the Junior integration first.`
      : "Junior is installed in more than one Sentry org, so the Sentry API path must name the org, such as /api/0/organizations/{org}/issues/{id}/.",
  );
}

function lease(token: string, expiresAtMs: number): PluginCredentialResult {
  return {
    type: "lease",
    lease: {
      expiresAt: new Date(expiresAtMs).toISOString(),
      headerTransforms: SENTRY_API_DOMAINS.map((domain) => ({
        domain,
        headers: { Authorization: `Bearer ${token}` },
      })),
    },
  };
}

/** Issue the installation token or org read token for the org read grant. */
export async function issueSentryCredential(
  ctx: IssueCredentialHookContext,
): Promise<PluginCredentialResult> {
  if (ctx.grant.name !== ORG_READ_GRANT) {
    throw new Error(
      `Sentry plugin cannot issue unknown grant "${ctx.grant.name}".`,
    );
  }
  const installationUuid = ctx.grant.leaseScope?.startsWith(
    INSTALLATION_SCOPE_PREFIX,
  )
    ? ctx.grant.leaseScope.slice(INSTALLATION_SCOPE_PREFIX.length)
    : undefined;
  if (installationUuid) {
    const config = sentryAppConfig();
    if (!config) {
      return {
        type: "unavailable",
        message:
          "Sentry installation access requires SENTRY_APP_CLIENT_ID and SENTRY_APP_CLIENT_SECRET.",
      };
    }
    const installationToken = await sentryInstallationToken(
      ctx.cache,
      config,
      installationUuid,
    );
    return lease(
      installationToken.token,
      Math.min(Date.now() + LEASE_MS, installationToken.expiresAtMs),
    );
  }
  const token = orgReadToken();
  if (!token) {
    return {
      type: "unavailable",
      message: "Sentry org read access requires SENTRY_READ_TOKEN.",
    };
  }
  return lease(token, Date.now() + LEASE_MS);
}
