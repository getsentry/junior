import { createApp } from "@sentry/junior";
import { juniorDashboardPlugin } from "@sentry/junior-dashboard";
import { initSentry } from "@sentry/junior/instrumentation";
import { exampleDashboardAuthRequired } from "./dashboard";

initSentry();

const app = await createApp({
  plugins: [
    juniorDashboardPlugin({
      authRequired: exampleDashboardAuthRequired(),
      allowedGoogleDomains: ["sentry.io"],
    }),
  ],
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
