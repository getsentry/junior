type GitHubPermissionLevel = "read" | "write" | "admin";
type GitHubPermissionRequest = Record<string, GitHubPermissionLevel>;

const GITHUB_PERMISSION_LEVELS: Record<
  string,
  readonly GitHubPermissionLevel[]
> = {
  actions: ["read", "write"],
  administration: ["read", "write"],
  artifact_metadata: ["read", "write"],
  attestations: ["read", "write"],
  checks: ["read", "write"],
  code_quality: ["read", "write"],
  codespaces: ["read", "write"],
  contents: ["read", "write"],
  custom_properties_for_organizations: ["read", "write"],
  dependabot_secrets: ["read", "write"],
  deployments: ["read", "write"],
  discussions: ["read", "write"],
  email_addresses: ["read", "write"],
  enterprise_custom_properties_for_organizations: ["read", "write", "admin"],
  environments: ["read", "write"],
  followers: ["read", "write"],
  git_ssh_keys: ["read", "write"],
  gpg_keys: ["read", "write"],
  interaction_limits: ["read", "write"],
  issues: ["read", "write"],
  members: ["read", "write"],
  merge_queues: ["read", "write"],
  metadata: ["read", "write"],
  organization_administration: ["read", "write"],
  organization_announcement_banners: ["read", "write"],
  organization_copilot_agent_settings: ["read", "write"],
  organization_copilot_seat_management: ["read", "write"],
  organization_custom_org_roles: ["read", "write"],
  organization_custom_properties: ["read", "write", "admin"],
  organization_custom_roles: ["read", "write"],
  organization_events: ["read"],
  organization_hooks: ["read", "write"],
  organization_packages: ["read", "write"],
  organization_personal_access_token_requests: ["read", "write"],
  organization_personal_access_tokens: ["read", "write"],
  organization_plan: ["read"],
  organization_projects: ["read", "write", "admin"],
  organization_secrets: ["read", "write"],
  organization_self_hosted_runners: ["read", "write"],
  organization_user_blocking: ["read", "write"],
  packages: ["read", "write"],
  pages: ["read", "write"],
  profile: ["write"],
  pull_requests: ["read", "write"],
  repository_custom_properties: ["read", "write"],
  repository_hooks: ["read", "write"],
  repository_projects: ["read", "write", "admin"],
  secret_scanning_alerts: ["read", "write"],
  secrets: ["read", "write"],
  security_events: ["read", "write"],
  single_file: ["read", "write"],
  starring: ["read", "write"],
  statuses: ["read", "write"],
  vulnerability_alerts: ["read", "write"],
  workflows: ["write"],
};

const KNOWN_GITHUB_PERMISSION_SCOPES = new Set(
  Object.keys(GITHUB_PERMISSION_LEVELS),
);

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

function isGitHubPermissionLevel(
  value: string,
): value is GitHubPermissionLevel {
  return value === "read" || value === "write" || value === "admin";
}

function supportsGitHubPermissionLevel(
  scope: string,
  level: GitHubPermissionLevel,
): boolean {
  return GITHUB_PERMISSION_LEVELS[scope]?.includes(level) ?? false;
}

function strongerGitHubPermissionLevel(
  existing: GitHubPermissionLevel | undefined,
  next: GitHubPermissionLevel,
): GitHubPermissionLevel {
  if (existing === "admin" || next === "admin") {
    return "admin";
  }
  if (existing === "write" || next === "write") {
    return "write";
  }
  return "read";
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
    if (!supportsGitHubPermissionLevel(scope, "read")) {
      throw new Error(`${context} contains non-readable scope "${rawScope}"`);
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
    if (!isGitHubPermissionLevel(level)) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const scope = normalizeGitHubPermissionScope(scopeRaw);
    if (
      !KNOWN_GITHUB_PERMISSION_SCOPES.has(scope) ||
      !supportsGitHubPermissionLevel(scope, level)
    ) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const existing = permissions[scope];
    permissions[scope] = strongerGitHubPermissionLevel(existing, level);
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

/** Project requested GitHub App permissions into the system-safe read-only subset. */
export function githubReadOnlyPermissionsFromPermissions(
  permissions: GitHubPermissionRequest,
): GitHubPermissionRequest {
  const readOnly: GitHubPermissionRequest = {
    metadata: "read",
  };
  for (const scope of Object.keys(permissions)) {
    if (supportsGitHubPermissionLevel(scope, "read")) {
      readOnly[scope] = "read";
    }
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
