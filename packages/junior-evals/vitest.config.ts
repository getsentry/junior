import { defineConfig } from "vitest/config";
import path from "node:path";

const juniorPackageRoot = path.resolve(__dirname, "../junior");

export default defineConfig({
  resolve: {
    // Vite 8 resolves tsconfig `paths` natively here:
    // https://vite.dev/config/shared-options.html#resolve-tsconfigpaths
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(juniorPackageRoot, "tests/msw/setup.ts")],
  },
});
