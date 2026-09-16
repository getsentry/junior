import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/chat/memory/index.ts" },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: true,
  outDir: "dist/memory",
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  clean: false,
});
