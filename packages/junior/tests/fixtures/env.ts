import fs from "node:fs";
import path from "node:path";
import { createEnvFileLoader } from "../../src/env/files";

const ENV_FILES = [".env", ".env.local", ".env.test", ".env.test.local"];

export interface JuniorTestEnvOptions {
  packageRoots: string[];
  workspaceRoot: string;
}

/**
 * Load Junior's test environment with apps/example defaults before local overrides.
 */
export function loadJuniorTestEnvFiles(options: JuniorTestEnvOptions): void {
  const applyEnvFile = createEnvFileLoader();
  const roots = [
    path.resolve(options.workspaceRoot, "apps/example"),
    options.workspaceRoot,
    ...options.packageRoots,
  ];
  const seen = new Set<string>();

  for (const root of roots) {
    const absoluteRoot = path.resolve(root);
    if (seen.has(absoluteRoot)) {
      continue;
    }
    seen.add(absoluteRoot);

    for (const envFile of ENV_FILES) {
      const absolutePath = path.resolve(absoluteRoot, envFile);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      applyEnvFile(absolutePath);
    }
  }
}
