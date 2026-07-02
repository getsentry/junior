import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

loadJuniorTestEnvFiles({
  packageRoots: [import.meta.dirname],
  workspaceRoot,
});

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@sentry\/junior$/,
        replacement: path.resolve(import.meta.dirname, "../junior/src/app.ts"),
      },
      {
        find: /^@sentry\/junior\/api\/people\/list$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../junior/src/api/people/list.ts",
        ),
      },
      {
        find: /^@sentry\/junior\/api\/people\/profile$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../junior/src/api/people/profile.ts",
        ),
      },
      {
        find: /^@sentry\/junior\/reporting$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../junior/src/reporting.ts",
        ),
      },
      {
        find: /^@\//,
        replacement: `${path.resolve(import.meta.dirname, "../junior/src")}/`,
      },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["json", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
