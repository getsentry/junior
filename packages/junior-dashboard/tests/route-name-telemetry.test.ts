import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Sentry from "@/chat/sentry";
import { scrubPrivateSentrySpan } from "@/chat/sentry-payload-filter";
import { resetDashboardEnv } from "./dashboard-test-helpers";

vi.mock("@sentry/junior/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/junior/api")>()),
  resolveViewerUser: async (email: string) => ({
    email,
    id: `user:${email}`,
    identities: [],
  }),
}));

type SentItem = {
  attributes: Record<string, { value: unknown }>;
  is_segment: boolean;
  name: string;
};

describe("HTTP route names on request spans", () => {
  const sent: SentItem[] = [];
  let fetchApp: (request: Request) => Promise<Response>;

  // The first import of the core and dashboard apps is slow under load.
  beforeAll(async () => {
    resetDashboardEnv();
    Sentry.init({
      dsn: "https://public@example.com/1",
      tracesSampleRate: 1,
      beforeSendSpan: scrubPrivateSentrySpan,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type !== "span") continue;
            sent.push(...(payload as { items: SentItem[] }).items);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    // Import the apps after init so the Hono integration patches Hono, like
    // the server entry that loads instrumentation first.
    const { Hono } = await import("hono");
    const { createDashboardApp } = await import("../src/app");
    vi.doMock("#junior/config", () => ({
      createDashboardApp,
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginRuntimeRegistrations: [],
      pluginSet: undefined,
      plugins: undefined,
    }));
    const { createApp, defineJuniorPlugins } = await import("@sentry/junior");
    const { defineJuniorPlugin } = await import("@sentry/junior-plugin-api");
    const memory = new Hono();
    memory.get("/memories", (c) => c.json({ ok: true }));
    const app = await createApp({
      allowedDomains: ["sentry.io"],
      dashboard: { authRequired: false },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "memory",
            displayName: "Memory",
            description: "Memory plugin",
          },
          hooks: { apiRoutes: () => memory },
        }),
      ]),
    });
    fetchApp = async (request) => await app.fetch(request);
  }, 60_000);

  afterAll(async () => {
    vi.doUnmock("#junior/config");
    await Sentry.getClient()?.close();
  });

  async function request(
    path: string,
    headers?: Record<string, string>,
  ): Promise<SentItem[]> {
    sent.length = 0;
    await Sentry.startSpan(
      {
        attributes: { "http.request.method": "GET" },
        forceTransaction: true,
        name: `GET ${path}`,
        op: "http.server",
      },
      async () => {
        await fetchApp(new Request(`http://localhost${path}`, { headers }));
      },
    );
    await Sentry.flush(2000);
    return sent;
  }

  it.each([
    [
      "/api/conversations/c%3A1/pending-messages",
      "/api/conversations/:conversationId/pending-messages",
      undefined,
    ],
    ["/api/plugins/memory/memories", "/api/plugins/memory/*", undefined],
    [
      "/api/internal/sandbox-egress/v1.token.sig/graphql",
      "/api/internal/sandbox-egress/<token>",
      {
        "vercel-forwarded-host": "api.github.com",
        "vercel-forwarded-scheme": "https",
        "vercel-sandbox-oidc-token": "invalid",
      },
    ],
  ])("names %s after the inner route", async (path, route, headers) => {
    const spans = await request(path, headers);
    const segment = spans.find((span) => span.is_segment);

    expect(segment?.name).toBe(`GET ${route}`);
    expect(segment?.attributes["http.route"]?.value).toBe(route);
    expect(segment?.attributes["app.http.route"]).toBeUndefined();
    for (const span of spans) {
      expect(span.attributes["sentry.segment.name"]?.value).toBe(
        `GET ${route}`,
      );
    }
  });
});
