import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import {
  exampleDashboardAuthRequired,
  exampleDashboardComponentGallery,
  exampleDashboardMockConversations,
} from "./dashboard.ts";

export default defineConfig({
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
