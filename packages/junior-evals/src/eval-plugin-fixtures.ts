import { generateKeyPairSync } from "node:crypto";
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { sentryPlugin } from "@sentry/junior-sentry";

/** Use the same plugin registrations in eval workers, snapshots, and egress. */
export function evalRuntimePlugins(
  packages: readonly string[],
): PluginRegistration[] {
  return [
    // The default config, as tests pass it to `agent({ plugins })`. The GitHub
    // mock answers the installation permission lookup.
    ...(packages.includes("@sentry/junior-github") ? [githubPlugin()] : []),
    ...(packages.includes("@sentry/junior-memory") ? [memoryPlugin()] : []),
    ...(packages.includes("@sentry/junior-sentry") ? [sentryPlugin()] : []),
  ];
}

const githubPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

/** Create disposable GitHub App inputs for the intercepted token exchange. */
export function evalGitHubEnv(): Record<string, string> {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_INSTALLATION_ID: "67890",
    GITHUB_APP_PRIVATE_KEY: githubPrivateKey,
    GITHUB_APP_BOT_NAME: "junior-eval",
    GITHUB_APP_BOT_EMAIL: "12345+junior-eval[bot]@users.noreply.github.com",
  };
}
