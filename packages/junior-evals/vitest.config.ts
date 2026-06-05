import { defineConfig } from "vitest/config";
import path from "node:path";

const juniorPackageRoot = path.resolve(__dirname, "../junior");
const pluginApiPackageRoot = path.resolve(__dirname, "../junior-plugin-api");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(juniorPackageRoot, "src"),
      "@junior-tests": path.resolve(juniorPackageRoot, "tests"),
      "@sentry/junior-plugin-api": path.resolve(
        pluginApiPackageRoot,
        "src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(juniorPackageRoot, "tests/msw/setup.ts")],
    unstubEnvs: true,
  },
});
