import { configDefaults, defineConfig } from "vitest/config";
import type { InlineConfig } from "vitest/node";
import { randomUUID } from "node:crypto";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";
import { authSuite } from "./src/suites/auth";
import { codingSuite } from "./src/suites/coding";

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
  process.env.VITEST_EVALS_OUTPUT_FILE ?? "integration-results.json",
);

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
// The agent test fixture calls the heartbeat route with this secret.
process.env.JUNIOR_SCHEDULER_SECRET ??= "junior-test-scheduler-secret";
// The agent test fixture mocks Vercel Blob, which stores attachments.
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_evalstore_secret";
// The agent test fixture signs GitHub webhooks with this secret.
process.env.GITHUB_WEBHOOK_SECRET ??= "junior-test-github-webhook-secret";
process.env.JUNIOR_STATE_ADAPTER = "redis";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval-integration:${randomUUID()}`;
process.env.REDIS_URL =
  process.env.JUNIOR_EVAL_REDIS_URL?.trim() || "redis://127.0.0.1:6382";
const evalRedisHostname = new URL(process.env.REDIS_URL).hostname;
if (evalRedisHostname !== "localhost" && evalRedisHostname !== "127.0.0.1") {
  throw new Error(
    `JUNIOR_EVAL_REDIS_URL must point at localhost or 127.0.0.1, got ${evalRedisHostname}`,
  );
}
process.env.VITEST_EVALS_REPLAY_MODE ??= "auto";

const resolve = {
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
};

const projectTest = {
  environment: "node",
  sequence: { setupFiles: "list", hooks: "stack" },
  setupFiles: [
    path.resolve(__dirname, "src/setup.ts"),
    path.resolve(juniorPackageRoot, "tests/msw/setup.ts"),
    path.resolve(juniorPackageRoot, "tests/fixtures/postgres/setup.ts"),
    path.resolve(__dirname, "src/eval-cleanup.ts"),
  ],
  testTimeout: EVAL_TEST_TIMEOUT_MS,
} satisfies InlineConfig;

// The directory of the auth suite. See `src/suites/auth.ts`.
const authSuiteRoot = "evals/integration/auth";
// The integration directory of the coding suite. See `src/suites/coding.ts`.
const codingSuiteRoot = "evals/integration/coding";

export default defineConfig({
  resolve,
  test: {
    fileParallelism: false,
    // Projects do not extend this config, so this global setup runs one time
    // and every project reads what it provides.
    globalSetup: [path.resolve(__dirname, "global-setup.ts")],
    maxWorkers: 1,
    outputFile: { json: evalReportPath },
    reporters: [new DefaultEvalReporter(), "json"],
    projects: [
      {
        resolve,
        test: {
          ...projectTest,
          name: "integration",
          // Strict system-correctness cases. Any failure fails the suite hard.
          // Fixture tests check the agent test fixture against real turns.
          include: [
            "evals/integration/**/*.eval.ts",
            "src/fixture/**/*.eval.ts",
          ],
          exclude: [
            ...configDefaults.exclude,
            `${authSuiteRoot}/**`,
            `${codingSuiteRoot}/**`,
          ],
        },
      },
      {
        resolve,
        test: {
          ...projectTest,
          ...authSuite,
          include: [`${authSuiteRoot}/**/*.eval.ts`],
        },
      },
      {
        resolve,
        test: {
          ...projectTest,
          ...codingSuite,
          include: [`${codingSuiteRoot}/**/*.eval.ts`],
        },
      },
    ],
  },
});
