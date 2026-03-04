import { defineConfig } from "vitest/config";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import fs from "node:fs";

// Load generic env first and test env last so test-specific values always win.
for (const envFile of [".env", ".env.local", ".env.test", ".env.test.local"]) {
  const absolutePath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(absolutePath)) continue;
  process.loadEnvFile(absolutePath);
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["tests/msw/setup.ts"],
    reporters: [new DefaultEvalReporter()]
  }
});
