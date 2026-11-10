import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadJuniorTestEnvFiles } from "./tests/fixtures/env";

const workspaceRoot = path.resolve(__dirname, "../..");
const packageRoot = process.cwd();

loadJuniorTestEnvFiles({ workspaceRoot, packageRoots: [packageRoot] });

process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
process.env.JUNIOR_SECRET = "junior-test-secret";
// `test-old` lets tests read values from a key that is not active.
process.env.JUNIOR_ENCRYPTION_KEYS =
  "test:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI,test-old:yzdMjBLutb3SqjtwO1Lm3Cr2wN7FSGG8tzlRjvJc8Xg";
process.env.JUNIOR_ENCRYPTION_KEY_ID = "test";
process.env.JUNIOR_STATE_ADAPTER = "memory";
process.env.JUNIOR_ATTACHMENT_STORAGE_PROVIDER = "memory";
process.env.JUNIOR_STATE_KEY_PREFIX ??= `junior:test:${process.pid}`;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Restore a real module after tests remove a virtual config mock.
      "#junior/config": path.resolve(
        __dirname,
        "tests/fixtures/virtual-config.ts",
      ),
      "@sentry/junior-plugin-api": path.resolve(
        __dirname,
        "../junior-plugin-api/src/index.ts",
      ),
      "@sentry/junior-memory": path.resolve(
        __dirname,
        "../junior-memory/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/unit/workflow/**/*.test.ts",
      "tests/integration/workflow/**/*.test.ts",
    ],
    globalSetup: ["tests/fixtures/postgres/global-setup.ts"],
    setupFiles: [
      "tests/msw/setup.ts",
      "tests/fixtures/postgres/setup.ts",
      "tests/fixtures/experimental-setup.ts",
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
