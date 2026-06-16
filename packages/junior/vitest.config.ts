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

const testProjects = [
  {
    extends: true,
    test: {
      name: "unit",
      include: ["tests/unit/**/*.test.ts"],
      testTimeout: 1_000,
    },
  },
  {
    extends: true,
    test: {
      name: "component",
      include: ["tests/component/**/*.test.ts"],
      testTimeout: 5_000,
    },
  },
  {
    extends: true,
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      testTimeout: 5_000,
    },
  },
];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@sentry/junior-plugin-api": path.resolve(
        __dirname,
        "../junior-plugin-api/src/index.ts",
      ),
      "@sentry/junior-scheduler": path.resolve(
        __dirname,
        "../junior-scheduler/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "tests/unit/workflow/**/*.test.ts",
      "tests/integration/workflow/**/*.test.ts",
    ],
    projects: testProjects,
    setupFiles: ["tests/msw/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["json", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
