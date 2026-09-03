import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: {
    compilerOptions: {
      // TODO(upstream): Remove after tsup stops adding deprecated baseUrl.
      ignoreDeprecations: "6.0",
    },
  },
  outDir: "dist",
  clean: true,
});
