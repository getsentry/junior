import { defineConfig } from "vitest/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJuniorTestEnvFiles } from "./tests/fixtures/env";

const workspaceRoot = path.resolve(__dirname, "../..");
const packageRoot = process.cwd();

loadJuniorTestEnvFiles({ workspaceRoot, packageRoots: [packageRoot] });

process.env["AI_GATEWAY_API_KEY"] = "test-gateway-key";
process.env["JUNIOR_SECRET"] = "junior-test-secret";
process.env["JUNIOR_STATE_ADAPTER"] = "memory";
process.env["JUNIOR_ATTACHMENT_STORAGE_PROVIDER"] = "memory";
process.env["JUNIOR_STATE_KEY_PREFIX"] ??= `junior:test:${process.pid}`;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Restore a real module after tests remove a virtual config mock.
      "#junior/config": path.resolve(
        __dirname,
        "tests/fixtures/virtual-config.ts",
      ),
      "#junior/system-prompts": path.resolve(
        __dirname,
        "tests/fixtures/virtual-system-prompts.ts",
      ),
      "@sentry/junior-plugin-api": path.resolve(
        __dirname,
        "../junior-plugin-api/src/index.ts",
      ),
      "@sentry/junior-notion": path.resolve(
        __dirname,
        "../junior-notion/src/index.ts",
      ),
      "@sentry/junior-sentry": path.resolve(
        __dirname,
        "../junior-sentry/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    // Undo vi.stubEnv after each test, so env does not leak into later files
    // in the same worker.
    unstubEnvs: true,
    // Inject the `pg` tracing channels that SQL budget tests count.
    execArgv: [
      "--import",
      pathToFileURL(
        path.resolve(__dirname, "tests/fixtures/pg-tracing-hook.ts"),
      ).href,
    ],
    exclude: [
      "tests/unit/workflow/**/*.test.ts",
      "tests/integration/workflow/**/*.test.ts",
    ],
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "component", include: ["tests/component/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Files in a worker share module state, so each file restores
          // what it changes.
          isolate: false,
        },
      },
    ],
    globalSetup: ["tests/fixtures/postgres/global-setup.ts"],
    setupFiles: [
      "tests/msw/setup.ts",
      "tests/fixtures/postgres/setup.ts",
      "tests/fixtures/experimental-setup.ts",
      "tests/fixtures/app-context-setup.ts",
      "tests/fixtures/setup.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["json", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
