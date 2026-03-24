import { defineConfig } from "vitest/config";
import DefaultEvalReporter from "vitest-evals/reporter";
import path from "node:path";
import fs from "node:fs";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const workspaceRoot = path.resolve(__dirname, "../..");

// Load workspace env first, then junior package env, with test env files last.
for (const envRoot of [workspaceRoot, juniorPackageRoot]) {
  for (const envFile of [
    ".env",
    ".env.local",
    ".env.test",
    ".env.test.local",
  ]) {
    const absolutePath = path.resolve(envRoot, envFile);
    if (!fs.existsSync(absolutePath)) continue;
    process.loadEnvFile(absolutePath);
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@junior-tests": path.resolve(juniorPackageRoot, "tests"),
    },
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    setupFiles: [path.resolve(juniorPackageRoot, "tests/msw/setup.ts")],
    reporters: [new DefaultEvalReporter()],
  },
});
