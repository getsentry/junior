/**
 * Sentry org read access.
 *
 * An internal integration token can read the Sentry organization that
 * installed the integration. Junior uses it for Sentry API reads. Writes use
 * the requesting user's OAuth token.
 */
import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginCredentialResult,
  PluginGrant,
} from "@sentry/junior-plugin-api";

export const SENTRY_API_DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];

const ORG_READ_GRANT = "org-read";
const LEASE_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function orgReadToken(): string | undefined {
  return process.env.SENTRY_READ_TOKEN?.trim() || undefined;
}

// The token acts as the integration's proxy user, not the requester. Reads
// that return the caller's own data stay on user OAuth: `/api/0/users/` and
// the personal inbox at `/api/0/organizations/{org}/inbox/`.
function isUserScopedPath(segments: string[]): boolean {
  return (
    segments[0] === "users" ||
    (segments[0] === "organizations" && segments[2] === "inbox")
  );
}

function isOrgReadRequest(request: EgressHookContext["request"]): boolean {
  if (!READ_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  const url = new URL(request.url);
  if (!SENTRY_API_DOMAINS.includes(url.hostname)) {
    return false;
  }
  const [api, version, ...segments] = url.pathname.split("/").filter(Boolean);
  return (
    api === "api" &&
    version === "0" &&
    segments.length > 0 &&
    !isUserScopedPath(segments)
  );
}

/**
 * Select the org read grant for Sentry API reads.
 *
 * Return undefined for other requests so the host uses the user's OAuth token.
 */
export function sentryGrantForEgress(
  ctx: EgressHookContext,
): PluginGrant | undefined {
  if (!orgReadToken() || !isOrgReadRequest(ctx.request)) {
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
