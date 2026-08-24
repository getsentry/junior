import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: true,
  splitting: true,
  external: ["@agentclientprotocol/sdk", "@sentry/junior-plugin-api", "zod"],
});
