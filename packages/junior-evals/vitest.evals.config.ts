import { defineConfig } from "vitest/config";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import fs from "node:fs";
import { createEnvFileLoader } from "../junior/src/env/files";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const applyEnvFile = createEnvFileLoader();
const EVAL_TEST_TIMEOUT_MS = 60_000;

// Load workspace env first, then junior package env, with test env files last.
for (const envRoot of [workspaceRoot, juniorPackageRoot]) {
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
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
process.env.JUNIOR_STATE_ADAPTER = "memory";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval:${process.pid}`;
process.env.VITEST_EVALS_REPLAY_MODE ??= "auto";

export default defineConfig({
  resolve: {
    // Vite 8 resolves tsconfig `paths` natively here:
    // https://vite.dev/config/shared-options.html#resolve-tsconfigpaths
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: [path.resolve(__dirname, "postgres-global-setup.ts")],
    include: ["evals/**/*.eval.ts"],
    maxWorkers: 1,
    setupFiles: [
      path.resolve(juniorPackageRoot, "tests/msw/setup.ts"),
      path.resolve(juniorPackageRoot, "tests/fixtures/postgres/setup.ts"),
    ],
    reporters: [new DefaultEvalReporter()],
    testTimeout: EVAL_TEST_TIMEOUT_MS,
  },
});
