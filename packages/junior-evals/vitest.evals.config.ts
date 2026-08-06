import { defineConfig } from "vitest/config";
import { randomUUID } from "node:crypto";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const evalsPackageRoot = __dirname;
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");
const memoryPackageRoot = path.resolve(__dirname, "../junior-memory");
// Leave room for harness cleanup and rubric judging after a reply reaches its
// separate 60-second behavior budget.
const EVAL_TEST_TIMEOUT_MS = 120_000;
const evalReportPath = path.resolve(
  evalsPackageRoot,
  process.env.VITEST_EVALS_OUTPUT_FILE ?? "vitest-results.json",
);

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval:${randomUUID()}`;
// Production defaults the model-facing spawn tool off; evals opt in by default.
process.env.JUNIOR_SUBAGENTS_ENABLED = "true";
process.env.REDIS_URL =
  process.env.JUNIOR_EVAL_REDIS_URL?.trim() || "redis://127.0.0.1:6382";
const evalRedisHostname = new URL(process.env.REDIS_URL).hostname;
if (evalRedisHostname !== "localhost" && evalRedisHostname !== "127.0.0.1") {
  throw new Error(
    `JUNIOR_EVAL_REDIS_URL must point at localhost or 127.0.0.1, got ${evalRedisHostname}`,
  );
}
process.env.AI_MODEL = "xai/grok-4.5";
process.env.AI_FAST_MODEL = "anthropic/claude-haiku-4.5";
process.env.AI_GUARDIAN_MODEL = "openai/gpt-5.6-luna";
process.env.AI_HANDOFF_MODEL = "openai/gpt-5.6-sol";
process.env.AI_MODEL_PROFILES = JSON.stringify({
  coding: "openai/gpt-5.6-sol",
});
process.env.VITEST_EVALS_REPLAY_MODE ??= "auto";

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
    // Vite 8 resolves tsconfig `paths` natively here:
    // https://vite.dev/config/shared-options.html#resolve-tsconfigpaths
    // The aliases above keep workspace package internals on source instead of package dist.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: [path.resolve(__dirname, "global-setup.ts")],
    include: ["evals/**/*.eval.ts"],
    maxWorkers: 1,
    setupFiles: [
      path.resolve(__dirname, "src/setup.ts"),
      path.resolve(juniorPackageRoot, "tests/msw/setup.ts"),
      path.resolve(juniorPackageRoot, "tests/fixtures/postgres/setup.ts"),
    ],
    outputFile: { json: evalReportPath },
    reporters: [new DefaultEvalReporter(), "json"],
    testTimeout: EVAL_TEST_TIMEOUT_MS,
  },
});
