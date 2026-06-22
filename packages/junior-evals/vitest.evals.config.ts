import { defineConfig } from "vitest/config";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");
const evalsPackageRoot = __dirname;
const EVAL_TEST_TIMEOUT_MS = 60_000;

loadJuniorTestEnvFiles({
  workspaceRoot,
  packageRoots: [juniorPackageRoot, evalsPackageRoot],
});

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
