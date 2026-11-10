import fs from "node:fs";
import path from "node:path";
import {
  createDefaultEnvFileLoader,
  createEnvFileLoader,
} from "../../src/env/files";

const ENV_FILES = [".env", ".env.local", ".env.test", ".env.test.local"];

export interface JuniorTestEnvOptions {
  packageRoots: string[];
  workspaceRoot: string;
}

/**
 * Load Junior's test environment with apps/example defaults before local overrides.
 */
export function loadJuniorTestEnvFiles(options: JuniorTestEnvOptions): void {
  const applyDefaultEnvFile = createDefaultEnvFileLoader();
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

    const examplePath = path.resolve(absoluteRoot, ".env.example");
    if (fs.existsSync(examplePath)) {
      applyDefaultEnvFile(examplePath);
    }

    for (const envFile of ENV_FILES) {
      const absolutePath = path.resolve(absoluteRoot, envFile);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      applyEnvFile(absolutePath);
    }
  }

  // Set after env files, like JUNIOR_SECRET, so a local key cannot change the
  // key ids that tests use. `test-old` lets tests read values from a key that
  // is not active.
  process.env.JUNIOR_ENCRYPTION_KEYS =
    "test:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI,test-old:yzdMjBLutb3SqjtwO1Lm3Cr2wN7FSGG8tzlRjvJc8Xg";
  process.env.JUNIOR_ENCRYPTION_KEY_ID = "test";
}
