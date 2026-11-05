import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Options } from "tsup";
import {
  DASHBOARD_CLIENT_MANIFEST_FILE,
  type DashboardClientManifest,
} from "./src/public-assets";

type EsbuildPlugin = NonNullable<Options["esbuildPlugins"]>[number];

const publicDir = "dist/public";

/**
 * Write the client manifest: the entry and every file it imports statically.
 * The page shell preloads those files, so the browser fetches them beside the
 * entry instead of after it.
 */
function clientManifestPlugin(): EsbuildPlugin {
  return {
    name: "junior-dashboard-client-manifest",
    setup(build) {
      build.onEnd((result) => {
        const outputs = result.metafile?.outputs;
        if (result.errors.length > 0 || !outputs) return;
        const entry = Object.keys(outputs).find(
          (file) => outputs[file]?.entryPoint === "src/client.tsx",
        );
        if (!entry) throw new Error("Dashboard client entry was not built");
        const imports = new Set<string>();
        const pending = [entry];
        for (let file = pending.pop(); file; file = pending.pop()) {
          for (const item of outputs[file]?.imports ?? []) {
            if (item.kind !== "import-statement" || imports.has(item.path)) {
              continue;
            }
            imports.add(item.path);
            pending.push(item.path);
          }
        }
        const name = (file: string) =>
          path.relative(publicDir, file).split(path.sep).join("/");
        const manifest: DashboardClientManifest = {
          entry: name(entry),
          imports: [...imports].map(name).sort(),
        };
        mkdirSync("dist", { recursive: true });
        writeFileSync(
          path.join("dist", DASHBOARD_CLIENT_MANIFEST_FILE),
          JSON.stringify(manifest),
        );
      });
    },
  };
}

export default defineConfig({
  entry: {
    client: "src/client.tsx",
  },
  format: "esm",
  // Fail the build when server-only code (Node builtins, @sentry/node) leaks
  // into the browser bundle. With the default "node" platform, esbuild keeps
  // those imports and the dashboard fails only at runtime in the browser.
  platform: "browser",
  tsconfig: "tsconfig.build.json",
  dts: false,
  // Only content-hashed browser files go here. Nitro serves this folder as
  // immutable static assets, so an unhashed file would stay cached forever.
  outDir: publicDir,
  clean: true,
  splitting: true,
  esbuildPlugins: [clientManifestPlugin()],
  esbuildOptions(options) {
    options.entryNames = "[name]-[hash]";
    options.chunkNames = "chunks/[name]-[hash]";
    // pnpm injects a separate copy of the plugin API into @sentry/junior.
    // Resolve every import to one copy, so the browser loads it once.
    options.alias = {
      "@sentry/junior-plugin-api": fileURLToPath(
        import.meta.resolve("@sentry/junior-plugin-api"),
      ),
    };
  },
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // @sentry/core and @sentry/browser-utils ship one build that keeps its
    // debug logging unless this flag is false.
    __SENTRY_DEBUG__: "false",
  },
  noExternal: [
    "@base-ui/react",
    "@sentry/browser",
    "@sentry/junior/api/schema",
    "@sentry/junior/version",
    "@sentry/junior-plugin-api",
    "@tanstack/react-query",
    "@tanstack/react-virtual",
    "@uidotdev/usehooks",
    "class-variance-authority",
    "cn",
    "lucide-react",
    "react",
    "react-dom",
    "react-is",
    "react-markdown",
    "react-resizable-panels",
    "react-router",
    "recharts",
    "remark-breaks",
    "remark-gfm",
    "shiki",
    "zod",
  ],
});
