import { randomUUID } from "node:crypto";
import path from "node:path";
import DefaultEvalReporter from "vitest-evals/reporter";
import { defineConfig } from "vitest/config";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const evalsPackageRoot = __dirname;
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");
// Leave room for provider retry inside the separate 60-second route budget.
const ROUTER_EVAL_TEST_TIMEOUT_MS = 90_000;
const evalReportPath = path.resolve(
  evalsPackageRoot,
  process.env.VITEST_EVALS_OUTPUT_FILE ?? "router-results.json",
);

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
// Router cases do not touch Redis state, but keep a loopback default so any
// accidental shared import that reads REDIS_URL stays sandboxed.
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval-router:${randomUUID()}`;
process.env.REDIS_URL =
  process.env.JUNIOR_EVAL_REDIS_URL?.trim() || "redis://127.0.0.1:6382";
process.env.AI_FAST_MODEL ??= "anthropic/claude-haiku-4.5";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
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
    globalSetup: [path.resolve(__dirname, "router-global-setup.ts")],
    include: ["evals/router/**/*.eval.ts"],
    maxWorkers: 1,
    outputFile: { json: evalReportPath },
    reporters: [new DefaultEvalReporter(), "json"],
    testTimeout: ROUTER_EVAL_TEST_TIMEOUT_MS,
  },
});
