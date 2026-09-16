import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../junior/src"),
      "@sentry/junior/src/chat/memory": path.resolve(
        __dirname,
        "../junior/src/chat/memory",
      ),
      "@sentry/junior/src/db/schema/memory": path.resolve(
        __dirname,
        "../junior/src/db/schema/memory.ts",
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
  },
});
