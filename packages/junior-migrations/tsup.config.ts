import { defineConfig } from "tsup";

const shared = {
  format: "esm" as const,
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
