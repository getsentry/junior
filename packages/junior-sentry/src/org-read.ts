/**
 * Org-wide Sentry read access for turns without a user token.
 *
 * An internal integration token can read one Sentry organization. Junior uses
 * it for read requests to that organization. All other requests use the
 * requesting user's OAuth token, so writes keep user permissions and audit
 * trails.
 */
import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginCredentialResult,
  PluginGrant,
} from "@sentry/junior-plugin-api";

export const SENTRY_READ_TOKEN_ENV = "SENTRY_READ_TOKEN";
export const SENTRY_READ_ORG_ENV = "SENTRY_READ_ORG";
export const SENTRY_API_DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];

const ORG_READ_GRANT = "org-read";
const LEASE_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// These API path prefixes put the organization slug in the next segment.
const ORG_SCOPED_PREFIXES = new Set(["organizations", "projects", "teams"]);

interface OrgReadConfig {
  org: string;
  token: string;
}

function readOrgReadConfig(): OrgReadConfig | undefined {
  const token = process.env[SENTRY_READ_TOKEN_ENV]?.trim();
  const org = process.env[SENTRY_READ_ORG_ENV]?.trim().toLowerCase();
  return token && org ? { org, token } : undefined;
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Return whether the org read token may serve this request.
 *
 * Org-scoped paths must name the configured organization. Paths without an
 * organization, such as `/api/0/issues/{id}/`, are scoped by Sentry to the
 * token's organization. User paths stay on user OAuth because the token has no
 * user.
 */
function isOrgReadRequest(
  request: EgressHookContext["request"],
  org: string,
): boolean {
  if (!READ_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (!SENTRY_API_DOMAINS.includes(url.hostname.toLowerCase())) {
    return false;
  }
  const [api, version, resource, orgSegment] = url.pathname
    .split("/")
    .filter(Boolean);
  if (api !== "api" || version !== "0" || !resource) {
    return false;
  }
  if (resource === "users") {
    return false;
  }
  if (!ORG_SCOPED_PREFIXES.has(resource) || orgSegment === undefined) {
    return true;
  }
  return decodeSegment(orgSegment) === org;
}

/**
 * Select the org read grant for read requests to the configured organization.
 *
 * Return undefined for every other request so the host uses the user's Sentry
 * OAuth token. Without a configured read token this always returns undefined.
 */
export function sentryGrantForEgress(
  ctx: EgressHookContext,
): PluginGrant | undefined {
  const config = readOrgReadConfig();
  if (!config || !isOrgReadRequest(ctx.request, config.org)) {
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
  const config = readOrgReadConfig();
  if (!config) {
    return {
      type: "unavailable",
      message: `Sentry org read access requires ${SENTRY_READ_TOKEN_ENV} and ${SENTRY_READ_ORG_ENV}.`,
    };
  }
  return {
    type: "lease",
    lease: {
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      headerTransforms: SENTRY_API_DOMAINS.map((domain) => ({
        domain,
        headers: { Authorization: `Bearer ${config.token}` },
      })),
    },
  };
}
