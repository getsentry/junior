import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "handlers/router": "src/handlers/router.ts",
    "handlers/webhooks": "src/handlers/webhooks.ts",
    "handlers/health": "src/handlers/health.ts",
    "next-config": "src/next-config.ts",
    instrumentation: "src/instrumentation.ts",
    "app/layout": "src/app/layout.tsx"
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: true,
  outDir: "dist",
  clean: true,
  splitting: true,
  external: [
    "next",
    "next/server",
    "react",
    "react-dom",
    "@sentry/nextjs",
    // All runtime npm dependencies stay external
    "@ai-sdk/gateway",
    "@chat-adapter/slack",
    "@chat-adapter/state-memory",
    "@chat-adapter/state-redis",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@sinclair/typebox",
    "@slack/web-api",
    "@vercel/sandbox",
    "ai",
    "bash-tool",
    "chat",
    "just-bash",
    "node-html-markdown",
    "workflow",
    "@workflow/serde",
    "yaml",
    "zod"
  ]
});
