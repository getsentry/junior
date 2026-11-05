import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@/chat/sentry";
import { scrubPrivateSentrySpan } from "@/chat/sentry-payload-filter";
import {
  nameRequestRoute,
  routeNameMiddleware,
} from "@/chat/sentry-route-name";

type SentItem = {
  attributes: Record<string, { value: unknown }>;
  is_segment: boolean;
  name: string;
};

describe("HTTP route names on request spans", () => {
  const sent: SentItem[] = [];
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
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
    // Import Hono after init so the integration patches it, like prod.
    const { Hono } = await import("hono");

    // Like the dashboard app: plugin dispatch and the Junior API sub-app.
    const api = new Hono();
    api.get("/api/conversations/:conversationId/pending-messages", (c) =>
      Sentry.startSpan({ name: "read", op: "db" }, () => c.json({})),
    );
    const dashboard = new Hono();
    dashboard.use("*", routeNameMiddleware());
    dashboard.all("/api/plugins/memory/*", () => new Response("plugin"));
    dashboard.route("/", api);

    // Like the core app: egress middleware, then `fetch()` into the dashboard.
    const core = new Hono();
    core.use("*", async function sandboxEgress(c, next) {
      if (!c.req.path.startsWith("/api/internal/sandbox-egress/")) {
        return await next();
      }
      nameRequestRoute(c.req.method, "/api/internal/sandbox-egress/:token/*");
      return new Response("egress");
    });
    core.all("/api/conversations/*", (c) => dashboard.fetch(c.req.raw));
    core.all("/api/plugins/*", (c) => dashboard.fetch(c.req.raw));

    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: core.fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(),
      );
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Sentry.getClient()?.close();
  });

  async function request(path: string): Promise<SentItem[]> {
    sent.length = 0;
    await fetch(`${baseUrl}${path}`);
    await Sentry.flush(2000);
    return sent.filter(
      (span) => span.attributes["sentry.op"]?.value !== "http.client",
    );
  }

  it.each([
    [
      "/api/conversations/c%3A1/pending-messages",
      "/api/conversations/:conversationId/pending-messages",
    ],
    ["/api/plugins/memory/conversations/c/memories", "/api/plugins/memory/*"],
    [
      "/api/internal/sandbox-egress/v1.token.sig/graphql",
      "/api/internal/sandbox-egress/:token/*",
    ],
  ])("names %s after the inner route", async (path, route) => {
    const spans = await request(path);
    const segment = spans.find((span) => span.is_segment);

    expect(segment?.name).toBe(`GET ${route}`);
    expect(segment?.attributes["http.route"]?.value).toBe(route);
    for (const span of spans) {
      expect(span.attributes["sentry.segment.name"]?.value).toBe(
        `GET ${route}`,
      );
    }
  });
});
