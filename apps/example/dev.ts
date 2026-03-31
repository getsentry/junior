import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { serve } from "@hono/node-server";
import { createApp } from "@sentry/junior";

const app = createApp({
  pluginPackages: [
    "@sentry/junior-agent-browser",
    "@sentry/junior-github",
    "@sentry/junior-notion",
    "@sentry/junior-sentry",
  ],
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});
