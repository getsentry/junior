import { describe, expect, it } from "vitest";
import { parseSentryExploreLink } from "../src/links/explore-urls.js";

function parse(path: string, query: Record<string, string | string[]> = {}) {
  const url = new URL(path);
  for (const [key, value] of Object.entries(query)) {
    for (const item of [value].flat()) url.searchParams.append(key, item);
  }
  return parseSentryExploreLink(url);
}

const field = (value: Record<string, unknown>) => JSON.stringify(value);

describe("Sentry Explore URLs", () => {
  it("reads a traces chart from either URL form", () => {
    const query = {
      aggregateField: [
        field({ groupBy: "span.op" }),
        field({ chartType: 1, yAxes: ["p95(span.duration)"] }),
      ],
      environment: "production",
      project: ["1", "2"],
      query: "span.op:http.client",
      statsPeriod: "24h",
    };
    const expected = {
      org: "acme",
      dataset: "spans",
      display: "line",
      pageTitle: "Explore traces",
      yAxes: ["p95(span.duration)"],
      groupBy: ["span.op"],
      query: "span.op:http.client",
      sort: "-p95(span.duration)",
      topEvents: 5,
      project: ["1", "2"],
      environment: ["production"],
      statsPeriod: "24h",
      start: undefined,
      end: undefined,
      interval: "5m",
    };
    expect(parse("https://acme.sentry.io/explore/traces/", query)).toEqual(
      expected,
    );
    expect(
      parse("https://sentry.io/organizations/acme/explore/traces/", query),
    ).toEqual(expected);
  });

  it("uses each page's defaults", () => {
    expect(parse("https://acme.sentry.io/explore/traces/")).toMatchObject({
      dataset: "spans",
      display: "bar",
      yAxes: ["count(span.duration)"],
      statsPeriod: "14d",
      interval: "1h",
      sort: undefined,
      topEvents: undefined,
    });
    expect(parse("https://acme.sentry.io/explore/logs/")).toMatchObject({
      dataset: "logs",
      yAxes: ["count(message)"],
    });
    expect(parse("https://acme.sentry.io/explore/metrics/")).toMatchObject({
      dataset: "tracemetrics",
      yAxes: ["sum(value)"],
    });
  });

  it("reads the legacy traces visualize value and the logs query", () => {
    expect(
      parse("https://acme.sentry.io/explore/traces/", {
        visualize: field({ chartType: 2, yAxes: ["avg(span.duration)"] }),
      }),
    ).toMatchObject({ display: "area", yAxes: ["avg(span.duration)"] });
    expect(
      parse("https://acme.sentry.io/explore/logs/", {
        aggregateField: [
          field({ groupBy: "severity" }),
          field({ yAxes: ["count(message)"] }),
        ],
        logsAggregateSortBys: "count(message)",
        logsQuery: "severity:error",
        // Only the samples table uses this sort.
        logsSortBys: "-timestamp",
      }),
    ).toMatchObject({
      groupBy: ["severity"],
      query: "severity:error",
      sort: "count(message)",
    });
  });

  it("draws the first visible metric, with all of its aggregates", () => {
    const metric = (visible: boolean, yAxes: string[]) =>
      field({
        aggregateFields: [
          { groupBy: "release" },
          { chartType: 1, visible, yAxes },
        ],
        aggregateSortBys: [{ field: yAxes[0], kind: "asc" }],
        query: "release:1.0",
      });
    expect(
      parse("https://acme.sentry.io/explore/metrics/", {
        metric: [
          metric(false, ["sum(value,hidden,counter,-)"]),
          metric(true, [
            "p50(value,latency,distribution,millisecond)",
            "p95(value,latency,distribution,millisecond)",
          ]),
        ],
      }),
    ).toMatchObject({
      display: "line",
      groupBy: ["release"],
      query: "release:1.0",
      sort: "p50(value,latency,distribution,millisecond)",
      yAxes: [
        "p50(value,latency,distribution,millisecond)",
        "p95(value,latency,distribution,millisecond)",
      ],
    });
    expect(
      parse("https://acme.sentry.io/explore/metrics/", {
        metric: metric(false, ["sum(value)"]),
      }),
    ).toBeUndefined();
  });

  it("drops a stale sort and a too fine interval", () => {
    expect(
      parse("https://acme.sentry.io/explore/traces/", {
        aggregateField: [
          field({ groupBy: "span.op" }),
          field({ yAxes: ["count(span.duration)"] }),
        ],
        aggregateSort: "-avg(span.self_time)",
        interval: "1m",
        statsPeriod: "7d",
      }),
    ).toMatchObject({ interval: "30m", sort: "-count(span.duration)" });
    expect(
      parse("https://acme.sentry.io/explore/traces/", {
        end: "2026-11-13T12:00:00",
        interval: "2h",
        start: "2026-11-13T00:00:00",
      }),
    ).toMatchObject({ interval: "2h" });
  });

  it("reads the time range the way Sentry's page filters do", () => {
    const range = (query: Record<string, string>) => {
      const link = parse("https://acme.sentry.io/explore/traces/", query);
      return {
        statsPeriod: link?.statsPeriod,
        start: link?.start,
        end: link?.end,
      };
    };
    // Sentry writes the bounds in UTC without a zone.
    expect(
      range({ start: "2026-11-13T00:00:00", end: "2026-11-13T12:00:00" }),
    ).toEqual({
      statsPeriod: undefined,
      start: "2026-11-13T00:00:00.000Z",
      end: "2026-11-13T12:00:00.000Z",
    });
    // A live period wins over stale bounds.
    expect(
      range({
        start: "2026-01-01T00:00:00",
        end: "2026-01-02T00:00:00",
        statsPeriod: "24h",
      }),
    ).toEqual({ statsPeriod: "24h", start: undefined, end: undefined });
    // Bounds count only as a valid pair.
    for (const query of [
      { start: "2026-11-13T00:00:00" },
      { start: "2026-11-13T12:00:00", end: "2026-11-13T00:00:00" },
      { start: "soon", end: "later" },
    ]) {
      expect(range(query)).toEqual({
        statsPeriod: "14d",
        start: undefined,
        end: undefined,
      });
    }
  });

  it("shows no chart for a heat map, a bad chart type, or another page", () => {
    expect(
      parse("https://acme.sentry.io/explore/metrics/", {
        metric: field({
          aggregateFields: [{ chartType: 3, yAxes: ["p50(value)"] }],
        }),
      }),
    ).toBeUndefined();
    expect(
      parse("https://acme.sentry.io/explore/traces/", {
        aggregateField: field({ chartType: 9, yAxes: ["count()"] }),
      }),
    ).toBeUndefined();
    expect(parse("https://acme.sentry.io/explore/profiles/")).toBeUndefined();
    expect(
      parse("https://acme.sentry.io/explore/traces/trace/abc/"),
    ).toBeUndefined();
    expect(parse("https://example.com/explore/traces/")).toBeUndefined();
  });
});
