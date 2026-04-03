import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const app = await createApp({
  pluginPackages: [
    "@sentry/junior-agent-browser",
    "@sentry/junior-github",
    "@sentry/junior-notion",
    "@sentry/junior-sentry",
  ],
});

export default app;
