/**
 * GitHub App installation targets.
 *
 * Owns how a GitHub request names the repository or organization whose App
 * installation it needs, and how a grant lease scope carries that target to
 * credential issuance.
 */

/** Repository or organization whose App installation a grant uses. */
export type GitHubInstallationTarget =
  | { name: string; owner: string }
  | { org: string };

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

/** Build the grant lease scope that keeps each target's installation lease apart. */
export function githubInstallationLeaseScope(
  target: GitHubInstallationTarget,
): string {
  return (
    "org" in target
      ? `organization:${target.org}`
      : `repository:${target.owner}/${target.name}`
  ).toLowerCase();
}

/**
 * Return the GitHub API path that finds the App installation for a lease
 * scope, and the target name for errors. Return undefined for no target.
 */
export function installationLookupForLeaseScope(
  leaseScope: string | undefined,
): { label: string; path: string } | undefined {
  const repository = /^repository:([^/]+)\/([^/]+)$/.exec(leaseScope ?? "");
  if (repository?.[1] && repository[2]) {
    return {
      label: `${repository[1]}/${repository[2]}`,
      path: `/repos/${encodeURIComponent(repository[1])}/${encodeURIComponent(repository[2])}/installation`,
    };
  }
  const org = /^organization:([^/]+)$/.exec(leaseScope ?? "")?.[1];
  return org
    ? { label: org, path: `/orgs/${encodeURIComponent(org)}/installation` }
    : undefined;
}
