import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const [
  { createApp },
  {
    exampleDashboardAuthRequired,
    exampleDashboardComponentGallery,
    exampleDashboardMockConversations,
  },
  { plugins },
] = await Promise.all([
  import("@sentry/junior"),
  import("./dashboard.ts"),
  import("./plugins.ts"),
]);

const app = await createApp({
  experimental: { acp: process.env.NODE_ENV === "development" },
  dashboard: {
    authRequired: exampleDashboardAuthRequired(),
    allowedGoogleDomains: ["sentry.io"],
    componentGallery: exampleDashboardComponentGallery(),
    mockConversations: exampleDashboardMockConversations(),
  },
  plugins,
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
