import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import DefaultEvalReporter from "vitest-evals/reporter";
import { loadJuniorTestEnvFiles } from "../junior/tests/fixtures/env";

const evalsPackageRoot = path.dirname(fileURLToPath(import.meta.url));
const juniorPackageRoot = path.resolve(evalsPackageRoot, "../junior");
const workspaceRoot = path.resolve(evalsPackageRoot, "../..");
const pluginApiPackageRoot = path.resolve(
  evalsPackageRoot,
  "../junior-plugin-api",
);
const memoryPackageRoot = path.resolve(evalsPackageRoot, "../junior-memory");

// Leave room for harness cleanup and rubric judging after a reply reaches its
// separate 60-second behavior budget.
const EVAL_TEST_TIMEOUT_MS = 120_000;

export type FullRuntimeEvalSuiteOptions = {
  /** Suite id used for Redis key prefix and default results file name. */
  name: string;
  include: string[];
  exclude?: string[];
  /** Extra setup files after the shared full-runtime setup chain. */
  setupFiles?: string[];
  env?: Record<string, string>;
};

/**
 * Shared Vitest config for full Slack/runtime eval suites.
 *
 * Suite configs stay thin: name, include/exclude, and optional env/setup only.
 * Guardian stays on its own lightweight config.
 */
export function createFullRuntimeEvalConfig(
  options: FullRuntimeEvalSuiteOptions,
) {
  const evalReportPath = path.resolve(
    evalsPackageRoot,
    process.env.VITEST_EVALS_OUTPUT_FILE ?? `${options.name}-results.json`,
  );

  loadJuniorTestEnvFiles({
    workspaceRoot,
    packageRoots: [juniorPackageRoot, evalsPackageRoot],
  });

  process.env.JUNIOR_SECRET = "junior-test-secret";
  process.env.JUNIOR_BASE_URL ??= "https://junior.example.com";
  process.env.JUNIOR_STATE_ADAPTER = "redis";
  process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:eval-${options.name}:${randomUUID()}`;
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

  for (const [key, value] of Object.entries(options.env ?? {})) {
    process.env[key] = value;
  }

  return defineConfig({
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
      globalSetup: [path.resolve(evalsPackageRoot, "global-setup.ts")],
      include: options.include,
      ...(options.exclude ? { exclude: options.exclude } : undefined),
      maxWorkers: 1,
      setupFiles: [
        path.resolve(evalsPackageRoot, "src/setup.ts"),
        path.resolve(juniorPackageRoot, "tests/msw/setup.ts"),
        path.resolve(juniorPackageRoot, "tests/fixtures/postgres/setup.ts"),
        path.resolve(juniorPackageRoot, "tests/fixtures/experimental-setup.ts"),
        ...(options.setupFiles ?? []),
      ],
      outputFile: { json: evalReportPath },
      reporters: [new DefaultEvalReporter(), "json"],
      testTimeout: EVAL_TEST_TIMEOUT_MS,
    },
  });
}
