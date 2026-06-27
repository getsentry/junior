import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import {
  exampleDashboardAuthRequired,
  exampleDashboardMockConversations,
} from "./dashboard.ts";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      dashboard: {
        authRequired: exampleDashboardAuthRequired(),
        allowedGoogleDomains: ["sentry.io"],
        mockConversations: exampleDashboardMockConversations(),
      },
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
