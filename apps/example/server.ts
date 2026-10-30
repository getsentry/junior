import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const [
  { createApp },
  { exampleDashboardAuthRequired, exampleDashboardMockConversations },
  { plugins },
] = await Promise.all([
  import("@sentry/junior"),
  import("./dashboard.ts"),
  import("./plugins.ts"),
]);

const app = await createApp({
  allowedDomains: ["sentry.io"],
  briefs: { enabled: true },
  dashboard: {
    authRequired: exampleDashboardAuthRequired(),
    mockConversations: exampleDashboardMockConversations(),
  },
  plugins,
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
