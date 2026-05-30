import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    app: "src/app.ts",
    client: "src/client.tsx",
    handler: "src/handler.ts",
    nitro: "src/nitro.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: true,
  splitting: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  external: [
    "#junior-dashboard/config",
    "@sentry/junior",
    "better-auth",
    "hono",
    "nitro",
  ],
  noExternal: [
    "@tanstack/react-query",
    "react",
    "react-dom",
    "react-router",
    "recharts",
    "shiki",
  ],
});
