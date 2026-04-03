import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      pluginPackages: [
        "@sentry/junior-agent-browser",
        "@sentry/junior-github",
        "@sentry/junior-notion",
        "@sentry/junior-sentry",
      ],
    }),
  ],
  routes: {
    "/api/**": { handler: "./server.ts" },
  },
});
