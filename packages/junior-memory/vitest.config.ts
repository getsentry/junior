import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Before the package root, which would also match this subpath.
      "@sentry/junior-plugin-api/embeddings": path.resolve(
        __dirname,
        "../junior-plugin-api/src/embeddings.ts",
      ),
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
    setupFiles: ["@sentry/junior-testing/postgres/setup"],
  },
});
