/**
 * Link cards for Sentry Explore charts: traces, logs, and metrics.
 *
 * A chart query covers the projects that its reader may see, so the
 * viewer's own Sentry account runs it, and Sentry decides access. The
 * result is cached per viewer and URL for a minute: `canView` runs the
 * query, and `resolve` draws the card from the same entry. Junior's org
 * read token only finds the org's region host. The card shows the series
 * shapes and names, never single events.
 */
import { createHash } from "node:crypto";
import {
  objectSummary,
  OBJECT_FACTS_MAX_BYTES,
  objectFactsBytes,
  type ObjectAnnotation,
  type ObjectFacts,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  parseSentryExploreLink,
  SENTRY_EXPLORE_LINK_FILTERS,
  type SentryExploreLink,
} from "./explore-urls.js";
import { sentryApi, sentryData } from "./api.js";
import { sentryRegionOrigin } from "./region.js";

// The same time as the card cache, so new data shows within a minute.
const CHART_CACHE_TTL_MS = 60_000;
const MAX_POINTS = 120;
const MAX_SERIES = 5;

type ChartFacts = Extract<ObjectFacts, { type: "chart" }>;
type Series = ChartFacts["series"][number];

/** What a chart card shows, read with the viewer's own token. */
interface SentryChart {
  display: ChartFacts["display"];
  displayType: string;
  title: string;
  yAxis: string;
  range: string;
  query?: string;
  series: Series[];
}

const timeseriesSchema = z.object({
  timeSeries: z.array(
    z.object({
      yAxis: z.string(),
      groupBy: z
        .array(z.object({ key: z.string(), value: z.unknown() }).loose())
        .nullish(),
      meta: z
        .object({
          isOther: z.boolean().optional(),
          order: z.number().optional(),
        })
        .loose()
        .optional(),
      values: z.array(z.object({ value: z.number().nullable() }).loose()),
    }),
  ),
});

const UNIT_NAMES: Record<string, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
};

/** Name a time range the way Sentry's date picker does. */
function rangeLabel(range: {
  statsPeriod?: string;
  start?: string;
  end?: string;
}): string {
  if (range.start && range.end) {
    const day = (value: string) =>
      new Date(value).toISOString().slice(0, 16).replace("T", " ");
    return `${day(range.start)} to ${day(range.end)} UTC`;
  }
  const match = /^(\d+)([smhdw])$/.exec(range.statsPeriod ?? "");
  if (!match) return "Last 14 days";
  const count = Number(match[1]);
  const unit = UNIT_NAMES[match[2]!]!;
  return count === 1 ? `Last ${unit}` : `Last ${count} ${unit}s`;
}

function text(value: string): string {
  return value.trim().slice(0, 160) || "(no value)";
}

// Average neighbor buckets down to `size` points, so the shape stays.
function downsample(points: number[], size: number): number[] {
  if (points.length <= size) return points;
  return Array.from({ length: size }, (_, index) => {
    const from = Math.floor((index * points.length) / size);
    const to = Math.floor(((index + 1) * points.length) / size);
    const bucket = points.slice(from, Math.max(to, from + 1));
    return bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
  });
}

/**
 * Keep the series within the facts limit: at most five, with three
 * significant digits, and fewer points until the facts fit.
 */
function fitFacts(chart: SentryChart): ChartFacts | undefined {
  const series = chart.series
    .slice(0, MAX_SERIES)
    .filter((item) => item.points.length >= 2);
  if (series.length === 0) return undefined;
  let size = MAX_POINTS;
  while (size >= 2) {
    const facts: ChartFacts = {
      type: "chart",
      summary: chart.query ? objectSummary(chart.query) : undefined,
      display: chart.display,
      yAxis: text(chart.yAxis),
      range: chart.range,
      series: series.map((item) => ({
        label: text(item.label),
        points: downsample(item.points, size).map((value) =>
          Number(value.toPrecision(3)),
        ),
      })),
    };
    if (objectFactsBytes(facts) <= OBJECT_FACTS_MAX_BYTES) return facts;
    size = Math.floor(size / 2);
  }
  return undefined;
}

function groupLabel(
  series: z.infer<typeof timeseriesSchema>["timeSeries"][number],
  grouped: boolean,
): string {
  if (series.meta?.isOther) return "Other";
  if (!grouped) return series.yAxis;
  return (
    (series.groupBy ?? [])
      .map(({ value }) =>
        value === null || value === undefined || value === ""
          ? "(no value)"
          : String(value),
      )
      .join(", ") || series.yAxis
  );
}

/**
 * Run the Explore chart query with the viewer's token. Nothing when Sentry
 * refuses it: the viewer has no Sentry account, may not see a queried
 * project, or the URL holds a query that Sentry rejects.
 */
async function readExploreChart(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryExploreLink,
): Promise<SentryChart | null> {
  const range =
    link.start && link.end
      ? { start: link.start, end: link.end }
      : { statsPeriod: link.statsPeriod };
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.events_timeseries.get",
  ).listOrganizationEventsTimeseries({
    path: { organization_id_or_slug: link.org },
    query: {
      dataset: link.dataset,
      interval: link.interval,
      yAxis: link.yAxes,
      groupBy: link.groupBy.length ? link.groupBy : undefined,
      project: link.project.length ? link.project : undefined,
      environment: link.environment.length ? link.environment : undefined,
      query: link.query,
      sort: link.sort,
      topEvents: link.topEvents,
      ...range,
    },
  });
  const data = sentryData(result, [400, 401, 403, 404], "chart query");
  const parsed = data === null ? undefined : timeseriesSchema.safeParse(data);
  if (!parsed?.success) return null;
  const grouped = link.groupBy.length > 0;
  return {
    display: link.display,
    displayType: link.pageTitle,
    title: grouped
      ? `${link.yAxes.join(", ")} by ${link.groupBy.join(", ")}`
      : link.yAxes.join(", "),
    yAxis: link.yAxes.join(", "),
    range: rangeLabel(link),
    query: link.query,
    series: [...parsed.data.timeSeries]
      .sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0))
      .map((series) => ({
        label: groupLabel(series, grouped),
        points: fillGaps(series.values.map(({ value }) => value)),
      })),
  };
}

// A bucket with no samples has no value, and that is not zero for an
// average or a percentile. Draw across it from its neighbors instead. A
// series with no values has no points.
function fillGaps(values: Array<number | null>): number[] {
  const known = values.flatMap((value, index) =>
    value === null ? [] : [index],
  );
  if (known.length === 0) return [];
  return values.map((value, index) => {
    if (value !== null) return value;
    const after = known.find((item) => item > index);
    const before = [...known].reverse().find((item) => item < index);
    if (before === undefined) return values[after!]!;
    if (after === undefined) return values[before]!;
    const from = values[before]!;
    const to = values[after]!;
    return from + ((to - from) * (index - before)) / (after - before);
  });
}

function urlHash(url: URL): string {
  return createHash("sha256").update(url.href).digest("hex");
}

/** Read the chart for this viewer, cached per viewer and URL. */
async function viewerChart(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<SentryChart | null> {
  const link = parseSentryExploreLink(url);
  if (!link) return null;
  return ctx.cache.getOrLoad(
    `chart:${ctx.viewer.id}:${urlHash(url)}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const chart = origin ? await readExploreChart(ctx, origin, link) : null;
      return { value: chart, ttlMs: CHART_CACHE_TTL_MS };
    },
  );
}

async function canViewSentryChartLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerChart(ctx, url)) !== null;
}

async function resolveSentryChartLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const chart = await viewerChart(ctx, url);
  const facts = chart && fitFacts(chart);
  if (!chart || !facts) return undefined;
  return {
    kind: "object",
    objectType: "chart",
    key: `chart:${urlHash(url).slice(0, 32)}`,
    label: chart.displayType,
    title: chart.title.slice(0, 512),
    // A long Explore URL does not fit the card. The link itself still works.
    url: url.href.length <= 2048 ? url.href : null,
    displayType: chart.displayType,
    facts,
  };
}

/** Sentry Explore charts, on sentry.io and customer domains. */
export const sentryChartLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryChartLink,
  filters: SENTRY_EXPLORE_LINK_FILTERS,
  objectType: "chart",
  resolve: resolveSentryChartLink,
};
