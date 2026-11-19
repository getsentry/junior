import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as z from "zod";
import { createCachedReport } from "@/api/cached-report";
import * as Sentry from "@/chat/sentry";
import { createWaitUntilCollector } from "../../fixtures/wait-until";

describe("cached report telemetry", () => {
  const spans: ReturnType<typeof Sentry.spanToJSON>[] = [];
  let client: ReturnType<typeof Sentry.init>;

  beforeAll(() => {
    client = Sentry.init({
      dsn: "https://public@example.com/1",
      tracesSampleRate: 1,
      defaultIntegrations: false,
      transport: () => ({
        send: async () => ({ statusCode: 200 }),
        flush: async () => true,
      }),
    });
    client?.on("spanEnd", (span) => {
      const json = Sentry.spanToJSON(span);
      const op = json.attributes?.["sentry.op"];
      if (op === "cache.get" || op === "cache.refresh") {
        spans.push(json);
      }
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await client?.close();
  });

  test("records cache hits, staleness, and background refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const background = createWaitUntilCollector();
    const readReport = createCachedReport({
      key: "telemetry-test-report",
      read: async () => ({ count: 1 }),
      refreshFailedEvent: "telemetry_test_report.refresh.failed",
      schema: z.object({ count: z.number() }).strict(),
    });
    const read = async () => {
      await readReport({ waitUntil: background.fn });
      return spans
        .filter((span) => span.attributes?.["sentry.op"] === "cache.get")
        .at(-1);
    };

    expect(await read()).toMatchObject({
      name: "telemetry-test-report",
      attributes: {
        "cache.key": "telemetry-test-report",
        "cache.hit": false,
        "cache.item_size": JSON.stringify({
          refreshAtMs: Date.parse("2026-06-15T12:05:00.000Z"),
          report: { count: 1 },
        }).length,
        "app.cache.stale": false,
        "app.cache.age_ms": 0,
      },
    });

    vi.setSystemTime(new Date("2026-06-15T12:06:00.000Z"));
    expect(await read()).toMatchObject({
      attributes: {
        "cache.hit": true,
        "app.cache.stale": true,
        "app.cache.age_ms": 6 * 60_000,
      },
    });

    await background.flush();
    expect(
      spans.filter(
        (span) => span.attributes?.["sentry.op"] === "cache.refresh",
      ),
    ).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "cache.key": "telemetry-test-report",
        }),
      }),
    ]);
  });
});
