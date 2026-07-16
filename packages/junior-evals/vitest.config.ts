import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");
const memoryPackageRoot = path.resolve(__dirname, "../junior-memory");
const schedulerPackageRoot = path.resolve(__dirname, "../junior-scheduler");

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, __dirname],
});

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@sentry/junior-memory": path.resolve(memoryPackageRoot, "src/index.ts"),
      "@sentry/junior-plugin-api": path.resolve(
        pluginApiPackageRoot,
        "src/index.ts",
      ),
      "@sentry/junior-scheduler": path.resolve(
        schedulerPackageRoot,
        "src/index.ts",
      ),
    },
    // Vite 8 resolves tsconfig `paths` natively here:
    // https://vite.dev/config/shared-options.html#resolve-tsconfigpaths
    // The aliases above keep workspace package internals on source instead of package dist.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    globalSetup: [path.resolve(__dirname, "postgres-global-setup.ts")],
    include: ["tests/**/*.test.ts"],
    setupFiles: [
      path.resolve(juniorPackageRoot, "tests/msw/setup.ts"),
      path.resolve(juniorPackageRoot, "tests/fixtures/postgres/setup.ts"),
    ],
  },
});
