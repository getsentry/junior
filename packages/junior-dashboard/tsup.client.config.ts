import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client.tsx",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: true,
  splitting: false,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  noExternal: [
    "@sentry/junior/api/schema",
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
