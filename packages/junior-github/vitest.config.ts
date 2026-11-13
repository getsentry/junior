import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sentry/junior-plugin-api": path.resolve(
        __dirname,
        "../junior-plugin-api/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["@sentry/junior-testing/postgres/global-setup"],
    setupFiles: ["@sentry/junior-testing/postgres/setup", "tests/setup.ts"],
    provide: {
      // This backfill copies GitHub rows into core tables, which these tests
      // do not create. Core depends on this package, so it cannot run core
      // migrations here.
      postgresSkipMigrations: ["0008_native_code_backfill.sql"],
    },
  },
});
