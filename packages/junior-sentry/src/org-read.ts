/**
 * Org-wide Sentry read access.
 *
 * An internal integration token can read the one Sentry organization that
 * installed the integration. Junior uses it for Sentry API reads in every turn.
 * Writes use the requesting user's OAuth token, so they keep user permissions
 * and audit trails.
 */
import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginCredentialResult,
  PluginGrant,
} from "@sentry/junior-plugin-api";

export const SENTRY_READ_TOKEN_ENV = "SENTRY_READ_TOKEN";
export const SENTRY_API_DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];

const ORG_READ_GRANT = "org-read";
const LEASE_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readOrgReadToken(): string | undefined {
  return process.env[SENTRY_READ_TOKEN_ENV]?.trim() || undefined;
}

/**
 * Return whether the org read token can serve this request.
 *
 * Sentry limits the token to its own organization, so Junior does not check
 * the organization here. `/api/0/users/` requests stay on user OAuth because
 * the token has no user.
 */
function isOrgReadRequest(request: EgressHookContext["request"]): boolean {
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
  const [api, version, resource] = url.pathname.split("/").filter(Boolean);
  return api === "api" && version === "0" && !!resource && resource !== "users";
}

/**
 * Select the org read grant for Sentry API reads.
 *
 * Return undefined for every other request so the host uses the user's Sentry
 * OAuth token. Without a configured read token this always returns undefined.
 */
export function sentryGrantForEgress(
  ctx: EgressHookContext,
): PluginGrant | undefined {
  if (!readOrgReadToken() || !isOrgReadRequest(ctx.request)) {
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
  const token = readOrgReadToken();
  if (!token) {
    return {
      type: "unavailable",
      message: `Sentry org read access requires ${SENTRY_READ_TOKEN_ENV}.`,
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
