import { defineConfig } from "nitro";
import { juniorDashboardNitro } from "@sentry/junior-dashboard/nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import { examplePluginPackages } from "./plugin-packages";

function isVercelEnvironment(): boolean {
  return Boolean(
    process.env.VERCEL?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(),
  );
}

/** Return whether the example dashboard should require browser auth. */
export function exampleDashboardAuthRequired(): boolean {
  return process.env.NODE_ENV !== "development" || isVercelEnvironment();
}

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: {
        packages: examplePluginPackages,
      },
    }),
    juniorDashboardNitro({
      authRequired: exampleDashboardAuthRequired(),
      allowedGoogleDomains: ["sentry.io"],
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
