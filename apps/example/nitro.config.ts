import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import { examplePluginPackages } from "./plugin-packages";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      pluginPackages: examplePluginPackages,
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
