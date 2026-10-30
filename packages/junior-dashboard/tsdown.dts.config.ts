import { defineConfig } from "tsdown";

// tsup still emits the server JavaScript. Its declaration bundler needs the
// TypeScript 6 compiler API, so tsdown bundles the public types instead.
export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  tsconfig: "tsconfig.build.json",
  dts: {
    emitDtsOnly: true,
  },
  outDir: "dist",
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  clean: false,
});
