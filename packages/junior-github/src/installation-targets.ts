/**
 * GitHub App installation targets.
 *
 * An App can be installed at most once per account, so the account that owns
 * a repository identifies the installation a request needs. This module owns
 * how a grant lease scope carries that owner to credential issuance.
 */

const OWNER_LEASE_SCOPE_PREFIX = "owner:";

function decodeGitHubPathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !decoded.includes("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a GitHub repository from an API or Git URL. */
export function githubRepositoryFromUrl(
  upstreamUrl: URL,
): { name: string; owner: string } | undefined {
  const segments = upstreamUrl.pathname.split("/").filter(Boolean);
  const host = upstreamUrl.hostname.toLowerCase();
  if (host === "api.github.com" && segments[0]?.toLowerCase() === "repos") {
    const owner = segments[1]
      ? decodeGitHubPathSegment(segments[1])
      : undefined;
    const name = segments[2] ? decodeGitHubPathSegment(segments[2]) : undefined;
    return owner && name ? { owner, name } : undefined;
  }
  if (host !== "github.com") {
    return undefined;
  }
  const owner = segments[0] ? decodeGitHubPathSegment(segments[0]) : undefined;
  const rawName = segments[1]?.replace(/\.git$/i, "");
  const name = rawName ? decodeGitHubPathSegment(rawName) : undefined;
  return owner && name ? { owner, name } : undefined;
}

/** Build the grant lease scope that keeps each owner's installation lease apart. */
export function githubOwnerLeaseScope(owner: string): string {
  return `${OWNER_LEASE_SCOPE_PREFIX}${owner.toLowerCase()}`;
}

/** Read the lowercase owner from a grant lease scope, if it names one. */
export function ownerFromLeaseScope(
  leaseScope: string | undefined,
): string | undefined {
  return leaseScope?.startsWith(OWNER_LEASE_SCOPE_PREFIX)
    ? leaseScope.slice(OWNER_LEASE_SCOPE_PREFIX.length) || undefined
    : undefined;
}
