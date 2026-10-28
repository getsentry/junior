import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");
const memoryPackageRoot = path.resolve(__dirname, "../junior-memory");
const packagesRoot = path.resolve(__dirname, "..");

// Read plugins from source, so tool specs never come from a stale build.
function pluginSource(name: string): string {
  return path.resolve(packagesRoot, name, "src/index.ts");
}

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, __dirname],
});

// Harness tests use local state; only live evals need shared Redis state.
process.env.JUNIOR_STATE_ADAPTER = "memory";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@sentry/junior-github": pluginSource("junior-github"),
      "@sentry/junior-google": pluginSource("junior-google"),
      "@sentry/junior-memory": path.resolve(memoryPackageRoot, "src/index.ts"),
      "@sentry/junior-plugin-api": path.resolve(
        pluginApiPackageRoot,
        "src/index.ts",
      ),
      "@sentry/junior-vercel": pluginSource("junior-vercel"),
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
      path.resolve(juniorPackageRoot, "tests/fixtures/experimental-setup.ts"),
    ],
  },
});
