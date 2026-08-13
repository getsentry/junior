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
  { workspaces },
] = await Promise.all([
  import("@sentry/junior"),
  import("./dashboard.ts"),
  import("./plugins.ts"),
  import("./workspaces.ts"),
]);

const app = await createApp({
  dashboard: {
    authRequired: exampleDashboardAuthRequired(),
    allowedGoogleDomains: ["sentry.io"],
    componentGallery: exampleDashboardComponentGallery(),
    mockConversations: exampleDashboardMockConversations(),
  },
  plugins,
  workspaces,
  configDefaults: {
    "sentry.org": "sentry",
  },
});

export default app;
