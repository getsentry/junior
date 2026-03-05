import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

const workspaceRoot = path.resolve(__dirname, "../..");
const packageRoot = process.cwd();

// Load workspace env first, then package env, with test env files last.
for (const envRoot of [workspaceRoot, packageRoot]) {
  for (const envFile of [".env", ".env.local", ".env.test", ".env.test.local"]) {
    const absolutePath = path.resolve(envRoot, envFile);
    if (!fs.existsSync(absolutePath)) continue;
    process.loadEnvFile(absolutePath);
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/unit/workflow/**/*.test.ts", "tests/integration/workflow/**/*.test.ts"],
    setupFiles: ["tests/msw/setup.ts"]
  }
});
