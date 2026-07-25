import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";
import {
  exampleDashboardAuthRequired,
  exampleDashboardComponentGallery,
  exampleDashboardMockConversations,
} from "./dashboard.ts";
import { plugins } from "./plugins.ts";

initSentry();

const app = await createApp({
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
