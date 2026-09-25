import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: {
    compilerOptions: {
      // TODO(upstream): Remove after tsup stops adding deprecated baseUrl.
      ignoreDeprecations: "6.0",
    },
  },
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  target: "node24",
});
