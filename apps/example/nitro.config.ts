import { withSentryConfig } from "@sentry/nitro";
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import {
  exampleDashboardAuthRequired,
  exampleDashboardComponentGallery,
  exampleDashboardMockConversations,
} from "./dashboard.ts";

const config = defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      dashboard: {
        authRequired: exampleDashboardAuthRequired(),
        allowedGoogleDomains: ["sentry.io"],
        componentGallery: exampleDashboardComponentGallery(),
        mockConversations: exampleDashboardMockConversations(),
      },
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});

export default withSentryConfig(config, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
