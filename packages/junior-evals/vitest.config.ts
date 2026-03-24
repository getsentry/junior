import { defineConfig } from "vitest/config";
import path from "node:path";

const juniorPackageRoot = path.resolve(__dirname, "../junior");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@junior-tests": path.resolve(juniorPackageRoot, "tests"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(juniorPackageRoot, "tests/msw/setup.ts")],
  },
});
