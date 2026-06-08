import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";

export type GitHubAppPermissionLevel = "read" | "write" | "admin";

/** Configure the built-in GitHub plugin manifest and hooks. */
export interface GitHubPluginOptions {
  /**
   * Extra OAuth `scope` values to request during GitHub App user authorization.
   *
   * GitHub App user tokens report empty scopes, so Junior treats this as a
   * local reauthorization contract only. Effective access still comes from the
   * app permissions, installation repositories, and requesting user's access.
   */
  additionalUserScopes?: string[];

  /**
   * GitHub App installation permissions Junior should request for app tokens.
   *
   * Keys may use GitHub permission names with underscores or hyphens. Junior
   * records these as plugin capabilities and requests read-only installation
   * tokens by scoping read-capable permissions down to `read`.
   * GitHub remains the source of truth for whether a permission exists.
   */
  appPermissions?: Record<string, GitHubAppPermissionLevel>;

  /** Environment variable containing the GitHub App id. */
  appIdEnv?: string;

  /** Environment variable containing Junior's Git committer email. */
  botEmailEnv?: string;

  /** Environment variable containing Junior's Git committer name. */
  botNameEnv?: string;

  /** Environment variable containing the GitHub App OAuth client id. */
  clientIdEnv?: string;

  /** Environment variable containing the GitHub App OAuth client secret. */
  clientSecretEnv?: string;

  /** Environment variable containing the GitHub App installation id. */
  installationIdEnv?: string;

  /** Environment variable containing the GitHub App private key. */
  privateKeyEnv?: string;
}

/** Register GitHub manifest content and runtime hooks. */
export function githubPlugin(
  options?: GitHubPluginOptions,
): JuniorPluginRegistration;
