import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";

export type GitHubAppPermissionLevel = "read" | "write";

export interface GitHubPluginOptions {
  /**
   * Additional OAuth `scope` values to include in the GitHub App user
   * authorization URL.
   *
   * GitHub App user-to-server tokens do not use OAuth scopes as their
   * permission model. GitHub returns `scope: ""` for these token responses;
   * Junior cannot verify granted scopes from the token response. Effective
   * access is enforced by the intersection of the GitHub App permissions,
   * installation repository access, and the requesting user's own access.
   *
   * Junior records the requested scope string as a local reauthorization
   * contract only. This is not proof that GitHub granted those scopes and does
   * not expand app permissions. Use `appPermissions` and the GitHub App's
   * configured permissions for GitHub API capabilities.
   */
  additionalUserScopes?: string[];
  appPermissions?: Record<string, GitHubAppPermissionLevel>;
  botEmailEnv?: string;
  botNameEnv?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

/** Register GitHub manifest content and trusted commit attribution hooks. */
export function githubPlugin(
  options?: GitHubPluginOptions,
): JuniorPluginRegistration;
