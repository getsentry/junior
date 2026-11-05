import {
  getClient,
  getCurrentScope,
  type BrowserOptions,
} from "@sentry/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initDashboardSentry, sendReplyRating } from "@dashboard/sentry";

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

    initDashboardSentry();

    expect(getClient()).toBeUndefined();
  });

  it("removes search text and element labels from spans", () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
    });

    initDashboardSentry();

    const options = getClient()?.getOptions();
    expect(options?.dsn).toBe("https://public@example.com/1");
    expect(options?.integrations.map(({ name }) => name)).toEqual([
      "BrowserTracing",
    ]);
    const scrubbed = options?.beforeSendSpan?.(
      span({
        "browser.web_vital.inp.target":
          'div.h-[1px] > a.absolute[aria-label="Open Private plans"][title="Private plans"]',
        "browser.web_vital.cls.source.1":
          'li[title="Fix "a"] > b[c"] > p[title="secret"] > span.x',
        "code.file.path": "http://localhost/conversations/c1?search=secret#top",
        "url.full": "http://localhost/api/conversations?q=secret",
        "url.query": "q=secret",
      }),
    );

    expect(scrubbed?.attributes).toEqual({
      "browser.web_vital.inp.target": "div.h-[1px] > a.absolute",
      "browser.web_vital.cls.source.1": "li > span.x",
      "code.file.path": "http://localhost/conversations/c1",
      "url.full": "http://localhost/api/conversations",
    });
  });

  it("sends a Reply rating with IDs only", async () => {
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
    initDashboardSentry();
    const items: unknown[] = [];
    getClient()?.on("beforeEnvelope", (envelope) => {
      items.push(...envelope[1].map(([, payload]) => payload));
    });

    sendReplyRating({ conversationId: "c1", messageId: "m1", rating: "bad" });

    await vi.waitFor(() => expect(items).toHaveLength(1));
    const event = items[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      contexts: {
        feedback: {
          message: "Bad reply",
          source: "dashboard_reply_rating",
          url: "http://localhost/conversations/c1",
        },
      },
      tags: {
        "app.reply.rating": "bad",
        "gen_ai.conversation.id": "c1",
        "messaging.message.id": "m1",
      },
      type: "feedback",
    });
    // The sent payload has no person, breadcrumbs, request, or page content.
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
});
