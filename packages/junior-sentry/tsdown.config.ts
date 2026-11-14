import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/testing.ts"],
  format: "esm",
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  sourcemap: false,
  target: "node24",
  tsconfig: "tsconfig.build.json",
});
