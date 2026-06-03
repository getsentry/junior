type GitHubPermissionRequest = Record<string, "read" | "write">;

const KNOWN_GITHUB_PERMISSION_SCOPES = new Set([
  "actions",
  "administration",
  "checks",
  "codespaces",
  "contents",
  "deployments",
  "environments",
  "issues",
  "metadata",
  "packages",
  "pages",
  "pull_requests",
  "repository_hooks",
  "repository_projects",
  "secret_scanning_alerts",
  "secrets",
  "security_events",
  "statuses",
  "vulnerability_alerts",
  "workflows",
]);

export const DEFAULT_GITHUB_SYSTEM_READ_SCOPES = new Set([
  "actions",
  "checks",
  "contents",
  "issues",
  "metadata",
  "pull_requests",
  "statuses",
]);

function normalizeGitHubPermissionScope(rawScope: string): string {
  return rawScope.trim().replace(/-/g, "_");
}

/** Validate and normalize GitHub App read scopes from plugin configuration. */
export function normalizeGitHubSystemReadPermissionScopes(
  scopes: string[],
  context: string,
): string[] {
  return scopes.map((rawScope) => {
    const scope = normalizeGitHubPermissionScope(rawScope);
    if (!KNOWN_GITHUB_PERMISSION_SCOPES.has(scope)) {
      throw new Error(`${context} contains unsupported scope "${rawScope}"`);
    }
    return scope;
  });
}

/** Convert plugin capabilities into the GitHub App installation permission body. */
export function githubCapabilitiesToPermissions(
  capabilities: string[],
  pluginName: string,
): GitHubPermissionRequest {
  const permissions: GitHubPermissionRequest = {};
  const prefix = `${pluginName}.`;
  for (const capability of capabilities) {
    if (!capability.startsWith(prefix)) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }
    const suffix = capability.slice(prefix.length);

    const lastDot = suffix.lastIndexOf(".");
    if (lastDot === -1) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }
    const scopeRaw = suffix.slice(0, lastDot);
    const level = suffix.slice(lastDot + 1);
    if (level !== "read" && level !== "write") {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const scope = normalizeGitHubPermissionScope(scopeRaw);
    if (!KNOWN_GITHUB_PERMISSION_SCOPES.has(scope)) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const existing = permissions[scope];
    permissions[scope] =
      existing === "write" || level === "write" ? "write" : "read";
  }

  return permissions;
}

/** Convert configured system scopes into read-only GitHub App permissions. */
export function githubSystemReadPermissionsFromScopes(
  scopes: string[],
): GitHubPermissionRequest {
  const readOnly: GitHubPermissionRequest = {
    metadata: "read",
  };
  for (const scope of normalizeGitHubSystemReadPermissionScopes(
    scopes,
    "GitHub system read permissions",
  )) {
    readOnly[scope] = "read";
  }
  return readOnly;
}

/** Intersect installation permissions with the allowed system read scope set. */
export function githubInstallationReadPermissions(
  permissions: Record<string, string> | undefined,
  allowedScopes: Set<string>,
): GitHubPermissionRequest {
  const readOnly: GitHubPermissionRequest = {
    metadata: "read",
  };
  for (const [scope, level] of Object.entries(permissions ?? {})) {
    if (
      !allowedScopes.has(scope) ||
      !KNOWN_GITHUB_PERMISSION_SCOPES.has(scope)
    ) {
      continue;
    }
    if (level === "read" || level === "write" || level === "admin") {
      readOnly[scope] = "read";
    }
  }
  return readOnly;
}
