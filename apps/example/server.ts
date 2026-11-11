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

// A Preview of a frontend change can show live data. Production apps do not
// load this entry point.
const liveOrigin = process.env.JUNIOR_DASHBOARD_LIVE_ORIGIN?.trim();
if (liveOrigin && exampleDashboardAuthRequired()) {
  throw new Error(
    "JUNIOR_DASHBOARD_LIVE_ORIGIN requires dashboard auth to be off",
  );
}

export default liveOrigin
  ? (await import("@sentry/junior-dashboard/live-preview")).withLivePreview(
      app,
      liveOrigin,
    )
  : app;
