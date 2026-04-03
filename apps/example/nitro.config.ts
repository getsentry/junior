import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [juniorNitro({})],
  routes: {
    "/api/**": { handler: "./server.ts" },
  },
});
