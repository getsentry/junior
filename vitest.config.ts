import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

for (const envFile of [".env.test.local", ".env.test", ".env.local", ".env"]) {
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
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/msw/setup.ts"]
  }
});
