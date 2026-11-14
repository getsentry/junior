/**
 * Sentry Explore URLs, read as the time series query that their chart runs.
 *
 * The rules follow Sentry's own Slack unfurl
 * (`integrations/slack/unfurl/explore.py`), so a card shows the chart that
 * the Explore page shows: the same y-axes, groups, sort, and interval.
 */
import type { ObjectLinkFilter } from "@sentry/junior-plugin-api";
import { sentryOrgPath } from "./urls.js";

const PAGES = {
  traces: {
    dataset: "spans",
    defaultYAxis: "count(span.duration)",
    title: "Explore traces",
  },
  logs: {
    dataset: "logs",
    defaultYAxis: "count(message)",
    title: "Explore logs",
  },
  metrics: {
    dataset: "tracemetrics",
    defaultYAxis: "sum(value)",
    title: "Explore metrics",
  },
} as const;

type ExplorePage = keyof typeof PAGES;

/** Filters for the Explore traces, logs, and metrics pages. */
export const SENTRY_EXPLORE_LINK_FILTERS: ObjectLinkFilter[] = Object.keys(
  PAGES,
).flatMap((page) => [
  { host: "sentry.io", pathPattern: `/organizations/*/explore/${page}` },
  { host: "*.sentry.io", pathPattern: `/explore/${page}` },
]);

/** How the Explore page draws the chart. */
export type ExploreDisplay = "line" | "bar" | "area";

/** The chart that an Explore URL shows, as an `events-timeseries` query. */
export interface SentryExploreLink {
  org: string;
  dataset: (typeof PAGES)[ExplorePage]["dataset"];
  display: ExploreDisplay;
  /** The page name, such as "Explore traces". */
  pageTitle: string;
  yAxes: string[];
  groupBy: string[];
  query?: string | undefined;
  sort?: string | undefined;
  topEvents?: number | undefined;
  project: string[];
  environment: string[];
  statsPeriod?: string;
  start?: string;
  end?: string;
  interval: string;
}

const DEFAULT_PERIOD = "14d";
const TOP_N = 5;
const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 } as const;
const PERIOD_PATTERN = /^(\d{1,6})([smhdw])$/;
// Explore's `MINIMUM_INTERVAL` ladder (`useChartInterval.tsx`): the
// smallest interval that the page allows for a time range.
const INTERVAL_LADDER: Array<[number, string]> = [
  [30 * UNIT_MS.d, "3h"],
  [14 * UNIT_MS.d, "1h"],
  [4 * UNIT_MS.d, "30m"],
  [48 * UNIT_MS.h, "10m"],
  [12 * UNIT_MS.h, "5m"],
  [0, "1m"],
];
const CHART_TYPES: Record<number, ExploreDisplay | "heatmap"> = {
  0: "bar",
  1: "line",
  2: "area",
  3: "heatmap",
};
// Explore draws these aggregates as bars by default, and others as lines.
const BAR_AGGREGATES = new Set(["count", "count_unique", "sum"]);

function periodMs(period: string): number | undefined {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

// Sentry writes `start` and `end` in UTC, without a zone.
function utcMs(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}Z`);
}

type TimeRange = { statsPeriod: string } | { start: string; end: string };

// Sentry's page filters treat a valid `statsPeriod` as a live window, even
// when the URL keeps stale `start` and `end` beside it. The bounds count
// only as a pair.
function timeRange(params: URLSearchParams): TimeRange {
  const period = params.get("statsPeriod") ?? "";
  if (periodMs(period) !== undefined) return { statsPeriod: period };
  const start = utcMs(params.get("start"));
  const end = utcMs(params.get("end"));
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return { statsPeriod: DEFAULT_PERIOD };
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

function rangeMs(range: TimeRange): number {
  return "statsPeriod" in range
    ? periodMs(range.statsPeriod)!
    : Date.parse(range.end) - Date.parse(range.start);
}

// A stale URL can ask for an interval finer than its range allows, and
// `events-timeseries` refuses that many buckets. Use the smallest allowed.
function chartInterval(params: URLSearchParams, range: TimeRange): string {
  const rangeLength = rangeMs(range);
  const minimum = INTERVAL_LADDER.find(
    ([threshold]) => rangeLength >= threshold,
  )![1];
  const requested = params.get("interval") ?? "";
  const requestedMs = periodMs(requested);
  return requestedMs !== undefined && requestedMs >= periodMs(minimum)!
    ? requested
    : minimum;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
}

interface Visualization {
  yAxes: string[];
  groupBy: string[];
  chartType?: number;
  query?: string | undefined;
  sort: string[];
}

// Traces and logs keep each chart and each group in an `aggregateField`
// JSON value. The first one with y-axes is the chart.
function aggregateFields(entries: Array<Record<string, unknown>>) {
  const visualization: Visualization = { yAxes: [], groupBy: [], sort: [] };
  for (const entry of entries) {
    if (typeof entry["groupBy"] === "string" && entry["groupBy"]) {
      visualization.groupBy.push(entry["groupBy"]);
    }
    const yAxes = strings(entry["yAxes"]);
    if (visualization.yAxes.length === 0 && yAxes.length > 0) {
      visualization.yAxes = yAxes;
      if (Number.isInteger(entry["chartType"])) {
        visualization.chartType = entry["chartType"] as number;
      }
    }
  }
  return visualization;
}

// Metrics keep each chart in its own `metric` JSON value. The first visible
// one is the chart, and all of its aggregates are series on that chart.
function metricVisualization(
  params: URLSearchParams,
): Visualization | undefined {
  const metrics = params.getAll("metric");
  if (metrics.length === 0) return { yAxes: [], groupBy: [], sort: [] };
  const metric = metrics
    .map(json)
    .find((parsed) => parsed && metricIsVisible(parsed));
  if (!metric) return undefined;
  const visualization: Visualization = { yAxes: [], groupBy: [], sort: [] };
  const fields = Array.isArray(metric["aggregateFields"])
    ? metric["aggregateFields"]
    : [];
  for (const field of fields.map(record)) {
    if (!field) continue;
    if (typeof field["groupBy"] === "string" && field["groupBy"]) {
      visualization.groupBy.push(field["groupBy"]);
    }
    const yAxes = strings(field["yAxes"]);
    visualization.yAxes.push(...yAxes);
    if (
      yAxes.length > 0 &&
      visualization.chartType === undefined &&
      Number.isInteger(field["chartType"])
    ) {
      visualization.chartType = field["chartType"] as number;
    }
  }
  const sorts = Array.isArray(metric["aggregateSortBys"])
    ? metric["aggregateSortBys"]
    : [];
  for (const sort of sorts.map(record)) {
    if (typeof sort?.["field"] === "string" && sort["field"]) {
      visualization.sort.push(
        sort["kind"] === "asc" ? sort["field"] : `-${sort["field"]}`,
      );
    }
  }
  if (typeof metric["query"] === "string" && metric["query"]) {
    visualization.query = metric["query"];
  }
  return visualization;
}

function metricIsVisible(metric: Record<string, unknown>): boolean {
  const fields = Array.isArray(metric["aggregateFields"])
    ? metric["aggregateFields"]
    : [];
  const chart = fields
    .map(record)
    .find((field) => Array.isArray(field?.["yAxes"]));
  return chart?.["visible"] !== false;
}

function visualization(
  page: ExplorePage,
  params: URLSearchParams,
): Visualization | undefined {
  if (page === "metrics") return metricVisualization(params);
  const entries =
    page === "traces" && !params.has("aggregateField")
      ? params.getAll("visualize")
      : params.getAll("aggregateField");
  return {
    ...aggregateFields(
      entries.map(json).filter((entry) => entry !== undefined),
    ),
    query: params.get(page === "traces" ? "query" : "logsQuery") || undefined,
    sort: params.getAll(
      page === "traces" ? "aggregateSort" : "logsAggregateSortBys",
    ),
  };
}

function display(
  chartType: number | undefined,
  yAxes: string[],
): ExploreDisplay | "heatmap" | undefined {
  if (chartType !== undefined) return CHART_TYPES[chartType];
  return yAxes.some((yAxis) => BAR_AGGREGATES.has(yAxis.split("(")[0]!))
    ? "bar"
    : "line";
}

/**
 * Return the chart that an Explore URL shows, or nothing when the page
 * shows no chart that a card can draw, such as a heat map or only hidden
 * metrics. Run it after a filter matched.
 */
export function parseSentryExploreLink(
  url: URL,
): SentryExploreLink | undefined {
  const orgPath = sentryOrgPath(url);
  const [explore, page, ...extra] = orgPath?.segments ?? [];
  if (!orgPath || explore !== "explore" || extra.length > 0) return undefined;
  if (!page || !Object.hasOwn(PAGES, page)) return undefined;
  const config = PAGES[page as ExplorePage];
  const params = url.searchParams;
  const chart = visualization(page as ExplorePage, params);
  if (!chart) return undefined;
  const yAxes = chart.yAxes.length > 0 ? chart.yAxes : [config.defaultYAxis];
  const shown = display(chart.chartType, yAxes);
  if (!shown || shown === "heatmap") return undefined;
  // Explore drops a sort that names neither a y-axis nor a group.
  const targets = new Set([...yAxes, ...chart.groupBy]);
  const sort = chart.sort.every((value) => targets.has(value.replace(/^-/, "")))
    ? chart.sort[0]
    : undefined;
  const grouped = chart.groupBy.length > 0;
  const range = timeRange(params);
  return {
    org: orgPath.org,
    dataset: config.dataset,
    display: shown,
    pageTitle: config.title,
    yAxes,
    groupBy: chart.groupBy,
    query: chart.query,
    sort: grouped ? (sort ?? `-${yAxes[0]}`) : sort,
    topEvents: grouped ? TOP_N : undefined,
    project: params.getAll("project"),
    environment: params.getAll("environment"),
    ...range,
    interval: chartInterval(params, range),
  };
}
