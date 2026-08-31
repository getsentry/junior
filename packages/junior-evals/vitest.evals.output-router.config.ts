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
// Leave room for provider retry inside the separate 60-second prepare budget.
const OUTPUT_ROUTER_EVAL_TEST_TIMEOUT_MS = 90_000;
const evalReportPath = path.resolve(
  evalsPackageRoot,
  process.env.VITEST_EVALS_OUTPUT_FILE ?? "output-router-results.json",
);

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
// Prepare cases do not touch Redis state, but keep a loopback default so any
// accidental shared import that reads REDIS_URL stays sandboxed.
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval-output-router:${randomUUID()}`;
process.env.REDIS_URL =
  process.env.JUNIOR_EVAL_REDIS_URL?.trim() || "redis://127.0.0.1:6382";
// Prepare path uses the fast model on one assistant message.
process.env.AI_FAST_MODEL ??= "openai/gpt-5.6-luna";

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
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: [path.resolve(__dirname, "output-router-global-setup.ts")],
    include: ["evals/output-router/**/*.eval.ts"],
    maxWorkers: 1,
    setupFiles: [path.resolve(__dirname, "src/output-router-setup.ts")],
    outputFile: { json: evalReportPath },
    reporters: [new DefaultEvalReporter(), "json"],
    testTimeout: OUTPUT_ROUTER_EVAL_TEST_TIMEOUT_MS,
  },
});
