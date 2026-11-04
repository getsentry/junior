import type { BrowserOptions } from "@sentry/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/browser")>()),
  init,
}));

import { initDashboardSentry } from "@dashboard/sentry";

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
    init.mockClear();
  });

  it("does not start without a server DSN", () => {
    vi.stubGlobal("window", {});

    initDashboardSentry();

    expect(init).not.toHaveBeenCalled();
  });

  it("removes search text and element labels from spans", () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
      },
    });

    initDashboardSentry();

    const options = init.mock.calls[0]?.[0] as BrowserOptions;
    expect(options.dsn).toBe("https://public@example.com/1");
    expect(options.defaultIntegrations).toBe(false);
    const scrubbed = options.beforeSendSpan?.(
      span({
        "browser.web_vital.inp.target":
          'div.h-[1px] > a.absolute[aria-label="Open Private plans"][title="Private plans"]',
        "code.file.path": "http://localhost/conversations/c1?search=secret#top",
        "url.full": "http://localhost/api/conversations?q=secret",
        "url.query": "q=secret",
      }),
    );

    expect(scrubbed?.attributes).toEqual({
      "browser.web_vital.inp.target": "div.h-[1px] > a.absolute",
      "code.file.path": "http://localhost/conversations/c1",
      "url.full": "http://localhost/api/conversations",
    });
  });
});
