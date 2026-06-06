import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";

export type GitHubAppPermissionLevel = "read" | "write" | "admin";

/** Configure the built-in GitHub plugin manifest and trusted hooks. */
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
   * Keys may use GitHub permission names with underscores or hyphens. Levels
   * may be `read`, `write`, or `admin` when GitHub supports that level for the
   * permission. When omitted, user-actor app tokens inherit the installed app
   * permission envelope; system-actor app tokens remain read-only.
   */
  appPermissions?: Record<string, GitHubAppPermissionLevel>;

  /** Environment variable containing Junior's Git committer email. */
  botEmailEnv?: string;

  /** Environment variable containing Junior's Git committer name. */
  botNameEnv?: string;

  /** Environment variable containing the GitHub App OAuth client id. */
  clientIdEnv?: string;

  /** Environment variable containing the GitHub App OAuth client secret. */
  clientSecretEnv?: string;
}

/** Register GitHub manifest content and trusted commit attribution hooks. */
export function githubPlugin(
  options?: GitHubPluginOptions,
): JuniorPluginRegistration;
