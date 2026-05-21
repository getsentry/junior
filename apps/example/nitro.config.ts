import { defineConfig } from "nitro";
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
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
