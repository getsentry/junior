import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: true,
  outDir: "dist",
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  clean: true,
});
