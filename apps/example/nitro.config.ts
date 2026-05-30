import { defineConfig } from "nitro";
import { juniorDashboardNitro } from "@sentry/junior-dashboard/nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import { examplePluginPackages } from "./plugin-packages";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: {
        packages: examplePluginPackages,
      },
    }),
    juniorDashboardNitro({
      authRequired: false,
      allowedGoogleDomains: ["sentry.io"],
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
