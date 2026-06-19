import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";
import { createEnvFileLoader } from "./src/env/files";

const workspaceRoot = path.resolve(__dirname, "../..");
const packageRoot = process.cwd();

const applyEnvFile = createEnvFileLoader();

// Load workspace env first, then package env, with test env files last.
for (const envRoot of [workspaceRoot, packageRoot]) {
  for (const envFile of [
    ".env",
    ".env.local",
    ".env.test",
    ".env.test.local",
  ]) {
    const absolutePath = path.resolve(envRoot, envFile);
    if (!fs.existsSync(absolutePath)) continue;
    applyEnvFile(absolutePath);
  }
}

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_STATE_ADAPTER = "memory";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:test:${process.pid}`;

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
      "@sentry/junior-scheduler": path.resolve(
        __dirname,
        "../junior-scheduler/src/index.ts",
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
