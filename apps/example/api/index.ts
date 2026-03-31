import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { handle } from "hono/vercel";

export default handle(
  createApp({
    pluginPackages: [
      "@sentry/junior-agent-browser",
      "@sentry/junior-github",
      "@sentry/junior-notion",
      "@sentry/junior-sentry",
    ],
  }),
);
