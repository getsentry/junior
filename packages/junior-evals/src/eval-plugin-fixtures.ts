import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parsePluginManifest } from "@/chat/plugins/manifest";
import type { InlinePluginManifestDefinition } from "@/chat/plugins/types";

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
