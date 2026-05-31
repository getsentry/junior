import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";
import { examplePlugins } from "./plugins";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: examplePlugins,
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
