import type { JuniorPlugin } from "@sentry/junior-plugin-api";

export interface GitHubPluginOptions {
  botEmailEnv?: string;
  botNameEnv?: string;
}

/** Register trusted GitHub runtime hooks for commit attribution and package loading. */
export function githubPlugin(options?: GitHubPluginOptions): JuniorPlugin;
