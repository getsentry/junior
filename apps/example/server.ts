import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const [
  { createApp },
  { exampleDashboardAuthRequired, exampleDashboardMockConversations },
  { plugins },
  { withExampleLivePreview },
] = await Promise.all([
  import("@sentry/junior"),
  import("./dashboard.ts"),
  import("./plugins.ts"),
  import("./live-preview.ts"),
]);
const { withVersionsListenSpike } = await import("./spike-versions-listen.ts");

// The spike Preview has no Junior secrets, so it serves only the spike routes.
export default process.env["VERCEL_ENV"] === "preview"
  ? withVersionsListenSpike({
      fetch: () => new Response("Not found", { status: 404 }),
    })
  : withVersionsListenSpike(
      withExampleLivePreview(
        await createApp({
          allowedDomains: ["sentry.io"],
          dashboard: {
            authRequired: exampleDashboardAuthRequired(),
            mockConversations: exampleDashboardMockConversations(),
          },
          plugins,
          configDefaults: {
            "sentry.org": "sentry",
          },
        }),
      ),
    );
