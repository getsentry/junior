import { randomUUID } from "node:crypto";
import path from "node:path";
import DefaultEvalReporter from "vitest-evals/reporter";
import { defineConfig } from "vitest/config";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const evalsPackageRoot = __dirname;
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");
const memoryPackageRoot = path.resolve(__dirname, "../junior-memory");
// Leave room for provider retry around the 10-second decision budget.
const CLASSIFIER_EVAL_TEST_TIMEOUT_MS = 90_000;
const evalReportPath = path.resolve(
  evalsPackageRoot,
  process.env.VITEST_EVALS_OUTPUT_FILE ?? "classifiers-results.json",
);

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
// Classifier cases do not touch Redis state, but keep a loopback default so any
// accidental shared import that reads REDIS_URL stays sandboxed.
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval-classifiers:${randomUUID()}`;
process.env.REDIS_URL =
  process.env.JUNIOR_EVAL_REDIS_URL?.trim() || "redis://127.0.0.1:6382";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@sentry/junior-memory": path.resolve(memoryPackageRoot, "src/index.ts"),
      "@sentry/junior-plugin-api": path.resolve(
        pluginApiPackageRoot,
        "src/index.ts",
      ),
    },
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    fileParallelism: false,
    // Cases only need AI Gateway access through Roach (`roach.json`).
    globalSetup: ["@sentry/roach/vitest"],
    include: ["evals/classifiers/**/*.eval.ts"],
    maxWorkers: 1,
    // `fetch-setup.ts` must run after the Roach setup file.
    sequence: { setupFiles: "list" },
    setupFiles: [
      path.resolve(__dirname, "src/stable-setup.ts"),
      "@sentry/roach/vitest/setup",
      path.resolve(__dirname, "src/fetch-setup.ts"),
    ],
    outputFile: { json: evalReportPath },
    reporters: [new DefaultEvalReporter(), "json"],
    testTimeout: CLASSIFIER_EVAL_TEST_TIMEOUT_MS,
  },
});
