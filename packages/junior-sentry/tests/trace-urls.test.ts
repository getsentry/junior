import { describe, expect, it } from "vitest";
import { parseSentryTraceLink } from "../src/links/trace-urls.js";

const TRACE_ID = "a8c0e1b2c3d4e5f60718293a4b5c6d7e";

describe("Sentry trace URLs", () => {
  it("reads both trace pages in both org URL forms", () => {
    for (const url of [
      `https://acme.sentry.io/explore/traces/trace/${TRACE_ID}/`,
      `https://sentry.io/organizations/acme/explore/traces/trace/${TRACE_ID}/`,
      `https://acme.sentry.io/performance/trace/${TRACE_ID.toUpperCase()}`,
      `https://sentry.io/organizations/acme/performance/trace/${TRACE_ID}/`,
    ]) {
      expect(parseSentryTraceLink(new URL(url))).toEqual({
        org: "acme",
        traceId: TRACE_ID,
      });
    }
  });

  it("keeps a valid trace timestamp only", () => {
    expect(
      parseSentryTraceLink(
        new URL(
          `https://acme.sentry.io/explore/traces/trace/${TRACE_ID}/?node=span-1&timestamp=1782896400.25`,
        ),
      ),
    ).toEqual({ org: "acme", traceId: TRACE_ID, timestamp: "1782896400.25" });
    expect(
      parseSentryTraceLink(
        new URL(
          `https://acme.sentry.io/explore/traces/trace/${TRACE_ID}/?timestamp=soon`,
        ),
      ),
    ).toEqual({ org: "acme", traceId: TRACE_ID });
  });

  it("reads no other page or trace id", () => {
    for (const url of [
      "https://acme.sentry.io/explore/traces/trace/not-a-trace/",
      `https://acme.sentry.io/explore/logs/trace/${TRACE_ID}/`,
      `https://acme.sentry.io/explore/traces/${TRACE_ID}/`,
    ]) {
      expect(parseSentryTraceLink(new URL(url))).toBeUndefined();
    }
  });
});
