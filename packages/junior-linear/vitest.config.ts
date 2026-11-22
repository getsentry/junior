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
    // Replay a failing order with `vitest run --sequence.seed=<seed from the banner>`.
    sequence: { shuffle: true },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
