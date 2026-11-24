import { defineConfig } from "nitro";
import { juniorNitro, withSentryConfig } from "@sentry/junior/nitro";
import {
  exampleDashboardAuthRequired,
  exampleDashboardMockConversations,
} from "./dashboard.ts";

const config = defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      dashboard: {
        authRequired: exampleDashboardAuthRequired(),
        mockConversations: exampleDashboardMockConversations(),
      },
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});

// The spike Preview has no Junior secrets, so it builds a bare Nitro
// function that serves only the spike routes.
const spikeConfig = defineConfig({
  preset: "vercel",
  vercel: { functions: { maxDuration: 300 } },
  serverEntry: "./spike-server.ts",
});

export default process.env["VERCEL_ENV"] === "preview"
  ? spikeConfig
  : withSentryConfig(config, {
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
    });
