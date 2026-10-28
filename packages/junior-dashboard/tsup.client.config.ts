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
  outDir: "dist",
  clean: true,
  splitting: true,
  esbuildOptions(options) {
    options.chunkNames = "chunks/[name]-[hash]";
  },
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  noExternal: [
    "@radix-ui/react-hover-card",
    "@sentry/junior/api/schema",
    "@sentry/junior/version",
    "@sentry/junior-plugin-api",
    "@tanstack/react-query",
    "lucide-react",
    "react",
    "react-dom",
    "react-is",
    "react-router",
    "shiki",
    "zod",
  ],
});
