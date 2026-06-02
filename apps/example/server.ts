import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";
import { plugins } from "./plugins.ts";

initSentry();

const app = await createApp({
  plugins,
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
