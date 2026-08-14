import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: ["src/index.ts"],
  external: ["@sentry/junior-plugin-api", "zod"],
  format: ["esm"],
  target: "node24",
});
