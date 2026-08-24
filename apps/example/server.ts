import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const [
  { createApp },
  { acpAdapter },
  {
    exampleDashboardAuthRequired,
    exampleDashboardComponentGallery,
    exampleDashboardMockConversations,
  },
  { plugins },
] = await Promise.all([
  import("@sentry/junior"),
  import("@sentry/junior-acp"),
  import("./dashboard.ts"),
  import("./plugins.ts"),
]);

const app = await createApp({
  adapters: [acpAdapter()],
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
