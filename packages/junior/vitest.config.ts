import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "./tests/fixtures/env";

const workspaceRoot = path.resolve(__dirname, "../..");
const packageRoot = process.cwd();

loadJuniorTestEnvFiles({ workspaceRoot, packageRoots: [packageRoot] });

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_STATE_ADAPTER = "memory";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:test:${process.pid}`;
// Production leaves experimental features off; the suite opts in so
// agent-invocation coverage exercises the real wiring path.
process.env.JUNIOR_EXPERIMENTAL = "subagents";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@sentry/junior-plugin-api": path.resolve(
        __dirname,
        "../junior-plugin-api/src/index.ts",
      ),
      "@sentry/junior-memory": path.resolve(
        __dirname,
        "../junior-memory/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/unit/workflow/**/*.test.ts",
      "tests/integration/workflow/**/*.test.ts",
    ],
    globalSetup: ["tests/fixtures/postgres/global-setup.ts"],
    setupFiles: ["tests/msw/setup.ts", "tests/fixtures/postgres/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["json", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
