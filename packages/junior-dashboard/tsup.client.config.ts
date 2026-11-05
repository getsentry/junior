import { defineConfig } from "tsup";

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
  outDir: "dist/public",
  clean: true,
  splitting: true,
  esbuildOptions(options) {
    options.entryNames = "[name]-[hash]";
    options.chunkNames = "chunks/[name]-[hash]";
  },
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  noExternal: [
    "@base-ui/react",
    "@sentry/browser",
    "@sentry/junior/api/schema",
    "@sentry/junior/version",
    "@sentry/junior-plugin-api",
    "@tanstack/react-query",
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
