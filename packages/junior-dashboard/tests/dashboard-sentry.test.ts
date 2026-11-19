import {
  getClient,
  getCurrentScope,
  startInactiveSpan,
  type BrowserOptions,
} from "@sentry/browser";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initDashboardSentry, sendFeedback } from "@dashboard/sentry";

type Span = Parameters<NonNullable<BrowserOptions["beforeSendSpan"]>>[0];

function span(attributes: Span["attributes"]): Span {
  return {
    attributes,
    is_segment: false,
    name: "Click",
    span_id: "span",
    start_timestamp: 1,
    status: "ok",
    trace_id: "trace",
  };
}

describe("dashboard browser Sentry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getCurrentScope().setClient(undefined);
  });

  it("does not start without a server DSN", () => {
    vi.stubGlobal("window", {});

    initDashboardSentry("classic");

    expect(getClient()).toBeUndefined();
  });

  it("removes search text and element labels from spans", () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
    });

    initDashboardSentry("classic");

    const options = getClient()?.getOptions();
    expect(options?.dsn).toBe("https://public@example.com/1");
    expect(options?.integrations.map(({ name }) => name)).toEqual([
      "BrowserTracing",
      "FetchTracing",
      "LinkedTraces",
      "LongTasks",
    ]);
    const scrubbed = options?.beforeSendSpan?.(
      span({
        "browser.web_vital.inp.target":
          'div.h-[1px] > a.absolute[aria-label="Open Private plans"][title="Private plans"]',
        "browser.web_vital.cls.source.1":
          'li[title="Fix "a"] > b[c"] > p[title="secret"] > span.x',
        "browser.script.invoker":
          'IMG[src="https://host/x.png?token=abc"].onerror',
        "code.file.path": "http://localhost/conversations/c1?search=secret#top",
        "url.full": "http://localhost/api/conversations?q=secret",
        "url.query": "q=secret",
      }),
    );

    expect(scrubbed?.attributes).toEqual({
      "browser.web_vital.inp.target": "div.h-[1px] > a.absolute",
      "browser.web_vital.cls.source.1": "li > span.x",
      "browser.script.invoker": "IMG.onerror",
      "code.file.path": "http://localhost/conversations/c1",
      "url.full": "http://localhost/api/conversations",
    });
  });

  it("sends a Reply rating with the reader, comment, and shell", async () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
      location: {
        origin: "http://localhost",
        pathname: "/conversations/c1",
      },
    });
    initDashboardSentry("inbox");
    const items: unknown[] = [];
    getClient()?.on("beforeEnvelope", (envelope) => {
      items.push(...envelope[1].map(([, payload]) => payload));
    });

    sendFeedback({
      comment: "Wrong repo",
      conversationId: "c1",
      kind: "reply_rating",
      messageId: "m1",
      rating: "bad",
      reader: { email: "ana@example.com", name: "Ana" },
    });

    await vi.waitFor(() => expect(items).toHaveLength(1));
    const event = items[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      contexts: {
        feedback: {
          contact_email: "ana@example.com",
          message: "Bad reply: Wrong repo",
          name: "Ana",
          source: "dashboard_reply_rating",
          url: "http://localhost/conversations/c1",
        },
      },
      tags: {
        "app.dashboard.ui": "inbox",
        "app.reply.rating": "bad",
        "gen_ai.conversation.id": "c1",
        "messaging.message.id": "m1",
      },
      type: "feedback",
    });
    // The reader is only in the feedback context. The sent payload has no
    // breadcrumbs, request, or page content.
    expect(Object.keys(JSON.parse(JSON.stringify(event))).sort()).toEqual([
      "contexts",
      "environment",
      "event_id",
      "level",
      "platform",
      "sdk",
      "tags",
      "timestamp",
      "type",
    ]);
  });

  it("sends general feedback with its topic and shell", async () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
      location: { origin: "http://localhost", pathname: "/" },
    });
    initDashboardSentry("inbox");
    const items: unknown[] = [];
    getClient()?.on("beforeEnvelope", (envelope) => {
      items.push(...envelope[1].map(([, payload]) => payload));
    });

    sendFeedback({
      comment: "The Inbox hides snoozed rows",
      kind: "general",
      reader: { email: "ana@example.com", name: "Ana" },
      topic: "new_ui",
    });

    await vi.waitFor(() => expect(items).toHaveLength(1));
    expect(items[0]).toMatchObject({
      contexts: {
        feedback: {
          contact_email: "ana@example.com",
          message: "The Inbox hides snoozed rows",
          name: "Ana",
          source: "dashboard_feedback",
        },
      },
      tags: { "app.dashboard.ui": "inbox", "app.feedback.topic": "new_ui" },
    });
  });

  it("names the shell on every span", async () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
    });
    initDashboardSentry("classic");
    const client = getClient();
    const items: unknown[] = [];
    client?.on("beforeEnvelope", (envelope) => {
      items.push(...envelope[1].map(([, payload]) => payload));
    });

    startInactiveSpan({ name: "Click", op: "ui.action" }).end();
    await client?.flush();

    expect(items).toMatchObject([
      {
        items: [
          {
            attributes: {
              "app.dashboard.ui": { type: "string", value: "classic" },
            },
          },
        ],
      },
    ]);
  });

  it("records the compressed body size on fetch spans", async () => {
    const body = gzipSync(JSON.stringify({ rows: "x".repeat(10_000) }));
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "application/json",
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
    });
    const originalFetch = globalThis.fetch;
    try {
      initDashboardSentry("classic");
      const client = getClient();
      const spans: Span[] = [];
      client?.on("beforeEnvelope", (envelope) => {
        for (const [, payload] of envelope[1]) {
          spans.push(...((payload as { items?: Span[] }).items ?? []));
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/report`);
      expect((await response.text()).length).toBeGreaterThan(10_000);
      await vi.waitFor(async () => {
        await client?.flush();
        expect(
          spans.find(
            ({ attributes }) =>
              (attributes["sentry.op"] as { value?: string })?.value ===
              "http.client",
          )?.attributes,
        ).toMatchObject({
          "http.response.body.size": { value: body.length },
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
      server.close();
    }
  });
});
