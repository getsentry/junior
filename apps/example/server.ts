import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";
import { examplePluginPackages } from "./plugin-packages";

initSentry();

const app = await createApp({
  plugins: {
    packages: examplePluginPackages,
  },
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
