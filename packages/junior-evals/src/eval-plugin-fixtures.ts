import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { sentryPlugin } from "@sentry/junior-sentry";
import { parsePluginManifest } from "@/chat/plugins/manifest";
import type { InlinePluginManifestDefinition } from "@/chat/plugins/types";

/** Use the same plugin registrations in eval workers, snapshots, and egress. */
export function evalRuntimePlugins(
  packages: readonly string[],
): PluginRegistration[] {
  return [
    ...(packages.includes("@sentry/junior-github")
      ? [githubPlugin({ appPermissions: { deployments: "read" } })]
      : []),
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

export interface EvalPluginFixtures {
  inlineManifests: InlinePluginManifestDefinition[];
  skillDirs: string[];
}

function pluginDirs(root: string): string[] {
  if (existsSync(path.join(root, "plugin.yaml"))) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(root, entry.name, "plugin.yaml")),
    )
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/** Load eval plugin manifests and skill roots without changing process cwd. */
export function loadEvalPluginFixtures(roots: string[]): EvalPluginFixtures {
  const inlineManifests: InlinePluginManifestDefinition[] = [];
  const skillDirs: string[] = [];
  for (const root of roots) {
    for (const pluginDir of pluginDirs(root)) {
      inlineManifests.push({
        dir: pluginDir,
        manifest: parsePluginManifest(
          readFileSync(path.join(pluginDir, "plugin.yaml"), "utf8"),
          pluginDir,
          undefined,
        ),
      });
      const skillsDir = path.join(pluginDir, "skills");
      if (statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
        skillDirs.push(skillsDir);
      }
    }
  }
  return { inlineManifests, skillDirs };
}
