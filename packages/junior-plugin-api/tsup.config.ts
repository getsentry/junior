import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
    },
  },
  outDir: "dist",
  clean: true,
});
