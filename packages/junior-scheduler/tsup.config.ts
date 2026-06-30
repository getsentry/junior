import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: true,
  external: ["@sentry/junior-plugin-api", "@sinclair/typebox"],
});
