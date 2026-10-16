import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  sourcemap: true,
  target: "node24",
});
