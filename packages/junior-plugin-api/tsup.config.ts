import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: true,
  outDir: "dist",
  clean: true,
});
