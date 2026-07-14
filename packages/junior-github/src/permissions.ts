export type GitHubAppPermissionLevel = "admin" | "read" | "write";

export type GitHubAppPermissions = Record<string, GitHubAppPermissionLevel>;

const LEVELS = new Set<unknown>(["read", "write", "admin"]);
// GitHub documents these installation-token permission fields as write-only.
const WRITE_ONLY_PERMISSIONS = new Set(["profile", "workflows"]);

function isLevel(value: unknown): value is GitHubAppPermissionLevel {
  return LEVELS.has(value);
}

function normalizeScope(rawScope: string): string {
  return String(rawScope).trim().replace(/-/g, "_");
}

/** Validate the configured GitHub App capability and read-token declaration. */
export function normalizePermissions(
  permissions: GitHubAppPermissions | undefined,
): GitHubAppPermissions | undefined {
  if (permissions === undefined) {
    return undefined;
  }

  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    throw new Error(
      "githubPlugin appPermissions must contain at least one permission when provided.",
    );
  }

  const request: GitHubAppPermissions = {};
  for (const [rawScope, rawLevel] of entries) {
    const normalizedScope = normalizeScope(rawScope);
    if (!normalizedScope) {
      throw new Error(
        "githubPlugin appPermissions contains an empty permission name.",
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(normalizedScope)) {
      throw new Error(
        `githubPlugin appPermissions contains invalid permission "${rawScope}".`,
      );
    }
    if (!isLevel(rawLevel)) {
      throw new Error(
        `githubPlugin appPermissions.${rawScope} must be "read", "write", or "admin".`,
      );
    }
    request[normalizedScope] = rawLevel;
  }
  return request;
}

/** Build the read-only installation-token permission body. */
export function readGrantPermissions(
  permissions: Record<string, unknown> | undefined,
): Record<string, "read"> {
  const readOnly: Record<string, "read"> = { metadata: "read" };
  for (const [scope, level] of Object.entries(permissions ?? {})) {
    if (!isLevel(level)) {
      throw new Error(
        `GitHub permission "${scope}" returned invalid level "${String(level)}".`,
      );
    }
    if (!WRITE_ONLY_PERMISSIONS.has(scope)) {
      readOnly[scope] = "read";
    }
  }
  return readOnly;
}

/** Expose configured permissions as plugin capabilities for host policy checks. */
export function permissionCapabilities(
  permissions: GitHubAppPermissions | undefined,
): string[] | undefined {
  if (permissions === undefined) {
    return undefined;
  }

  return Object.entries(permissions)
    .map(([normalizedScope, rawLevel]) => {
      const scope = normalizedScope.replace(/_/g, "-");
      return `github.${scope}.${rawLevel}`;
    })
    .sort();
}
