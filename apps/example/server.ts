import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";
import { examplePlugins } from "./plugins";

initSentry();

const app = await createApp({
  plugins: examplePlugins,
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
