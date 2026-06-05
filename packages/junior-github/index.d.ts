import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";

export type GitHubAppPermissionLevel = "read" | "write";

export interface GitHubPluginOptions {
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
