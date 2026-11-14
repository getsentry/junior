/**
 * Link cards for Sentry dashboards and their widgets.
 *
 * The viewer's own Sentry account reads the dashboard and runs each chart
 * query, so Sentry decides who may see them. A dashboard card lists the
 * saved filters and the first widgets, with small charts of the first
 * widgets that a card can draw. A widget link shows a chart card. Only
 * spans, logs, and trace metrics widgets drawn as a line, area, or bar
 * chart are drawn: other widgets read Discover or draw no time series.
 * Each read is cached per viewer and URL for a minute: `canView` reads,
 * and `resolve` draws the card from the same entry. Junior's org read
 * token only finds the org's region host.
 */
import {
  OBJECT_FACTS_MAX_BYTES,
  objectFactsBytes,
  type ObjectAnnotation,
  type ObjectFacts,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import {
  chartCard,
  downsample,
  rangeLabel,
  readExploreChart,
  urlHash,
  type SentryChart,
} from "./charts.js";
import {
  parseSentryDashboardLink,
  SENTRY_DASHBOARD_LINK_FILTERS,
  SENTRY_DASHBOARD_WIDGET_LINK_FILTERS,
  type SentryDashboardLink,
} from "./dashboard-urls.js";
import {
  chartInterval,
  timeRange,
  type ExploreDisplay,
  type SentryExploreLink,
  type TimeRange,
} from "./explore-urls.js";
import { sentryRegionOrigin } from "./region.js";

// The same time as the card cache.
const DASHBOARD_CACHE_TTL_MS = 60_000;
// Sentry refuses a dashboard that the token may not read.
const REFUSED = [400, 401, 403, 404];
const MAX_WIDGETS = 8;
const MAX_CHARTS = 3;
const MAX_CHART_SERIES = 3;
const MAX_CHART_POINTS = 60;
// The most projects or environments that a card lists.
const MAX_LISTED = 5;
const TOP_N = 5;
// The widget types whose queries are not Discover, by `events-timeseries`
// dataset.
const CHART_DATASETS: Record<string, SentryExploreLink["dataset"]> = {
  spans: "spans",
  logs: "logs",
  tracemetrics: "tracemetrics",
};
const CHART_DISPLAYS = new Set<string>(["line", "area", "bar"]);

type DashboardFacts = Extract<ObjectFacts, { type: "dashboard" }>;

const widgetSchema = z.object({
  title: z.string(),
  displayType: z.string().nullish(),
  widgetType: z.string().nullish(),
  interval: z.string().nullish(),
  limit: z.number().int().positive().nullish(),
  queries: z.array(
    z.object({
      aggregates: z.array(z.string()).nullish(),
      columns: z.array(z.string()).nullish(),
      conditions: z.string().nullish(),
      orderby: z.string().nullish(),
      isHidden: z.boolean().nullish(),
    }),
  ),
});
type Widget = z.infer<typeof widgetSchema>;

const dashboardSchema = z.object({
  title: z.string(),
  widgets: z.array(widgetSchema),
  projects: z.array(z.number().int()).nullish(),
  environment: z.array(z.string()).nullish(),
  period: z.string().nullish(),
  start: z.string().nullish(),
  end: z.string().nullish(),
  filters: z
    .object({
      release: z.array(z.string()).nullish(),
      globalFilter: z
        .array(z.object({ dataset: z.string(), value: z.string() }))
        .nullish(),
    })
    .nullish(),
});
type Dashboard = z.infer<typeof dashboardSchema>;

const projectsSchema = z.array(z.object({ id: z.string(), slug: z.string() }));

/** The page filters that a dashboard's widgets run with. */
interface WidgetFilters {
  project: string[];
  environment: string[];
  release: string[];
  range: TimeRange;
}

/** What a dashboard card shows, read with the viewer's own token. */
interface SentryDashboard {
  title: string;
  widgetCount: number;
  projects: string[];
  environments: string[];
  range: string;
  widgets: Array<{ title: string; display: string }>;
  charts: SentryChart[];
}

function text(value: string, empty: string): string {
  return value.trim().slice(0, 160) || empty;
}

// Sentry names display types in snake case, such as `big_number`.
function displayName(display: string | null | undefined): string {
  if (!display) return "Line chart";
  if (CHART_DISPLAYS.has(display)) {
    return `${display[0]!.toUpperCase()}${display.slice(1)} chart`;
  }
  const words = display.replaceAll("_", " ");
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

// The URL's page filters replace the saved ones, as on the dashboard page.
function widgetFilters(
  dashboard: Dashboard,
  link: SentryDashboardLink,
): WidgetFilters {
  const saved = new URLSearchParams();
  if (dashboard.start && dashboard.end) {
    saved.set("start", dashboard.start);
    saved.set("end", dashboard.end);
  } else if (dashboard.period) {
    saved.set("statsPeriod", dashboard.period);
  }
  const { filters } = link;
  return {
    project: filters.project.length
      ? filters.project
      : (dashboard.projects ?? []).map(String),
    environment: filters.environment.length
      ? filters.environment
      : (dashboard.environment ?? []),
    release: filters.release.length
      ? filters.release
      : (dashboard.filters?.release ?? []),
    range: filters.range ?? timeRange(saved),
  };
}

// The dashboard filters join a widget's own conditions, the way Sentry's
// `applyDashboardFilters` joins them. A global filter applies only to
// widgets of its dataset.
function widgetQuery(
  conditions: string,
  widgetType: string,
  dashboard: Dashboard,
  filters: WidgetFilters,
): string | undefined {
  const parts: string[] = [];
  if (filters.release.length === 1) {
    parts.push(`release:"${filters.release[0]}"`);
  } else if (filters.release.length > 1) {
    parts.push(`release:[${filters.release.map((r) => `"${r}"`).join(",")}]`);
  }
  for (const filter of dashboard.filters?.globalFilter ?? []) {
    if (filter.dataset === widgetType && filter.value) parts.push(filter.value);
  }
  const extra = parts.join(" ");
  if (!extra) return conditions || undefined;
  return conditions ? `(${conditions}) ${extra}` : extra;
}

/**
 * Return the chart query of a widget, the way the dashboard runs it, or
 * nothing for a widget that a card does not draw. A widget with more than
 * one query draws its first shown query.
 */
function widgetChart(
  org: string,
  widget: Widget,
  dashboard: Dashboard,
  filters: WidgetFilters,
): SentryExploreLink | undefined {
  const widgetType = widget.widgetType ?? "";
  const dataset = CHART_DATASETS[widgetType];
  const display = widget.displayType ?? "line";
  const query = widget.queries.find((item) => !item.isHidden);
  const yAxes = query?.aggregates ?? [];
  if (!dataset || !CHART_DISPLAYS.has(display) || !query || !yAxes.length) {
    return undefined;
  }
  const groupBy = query.columns ?? [];
  const grouped = groupBy.length > 0;
  return {
    org,
    dataset,
    display: display as ExploreDisplay,
    pageTitle: "Dashboard widget",
    yAxes,
    groupBy,
    query: widgetQuery(query.conditions ?? "", widgetType, dashboard, filters),
    sort: query.orderby || (grouped ? `-${yAxes[0]}` : undefined),
    topEvents: grouped ? Math.min(widget.limit ?? TOP_N, TOP_N) : undefined,
    project: filters.project,
    environment: filters.environment,
    ...filters.range,
    interval: chartInterval(widget.interval ?? "", filters.range),
  };
}

async function readWidgetChart(
  ctx: ObjectLinkContext,
  origin: string,
  query: SentryExploreLink,
  title: string,
): Promise<SentryChart | null> {
  const chart = await readExploreChart(ctx, origin, query);
  return chart && { ...chart, title: text(title, "Untitled widget") };
}

/** Read the dashboard with the viewer's token. Nothing when Sentry refuses. */
async function readDashboard(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryDashboardLink,
): Promise<Dashboard | null> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.dashboard.get",
  ).getOrganizationDashboard({
    path: { organization_id_or_slug: link.org, dashboard_id: link.dashboardId },
  });
  const data = sentryData(result, REFUSED, "dashboard read");
  const parsed = data === null ? undefined : dashboardSchema.safeParse(data);
  return parsed?.success ? parsed.data : null;
}

// Sentry reads `-1` as all projects, and no project as the viewer's own.
// Other ids are named by the projects that Sentry lists for the viewer.
async function projectNames(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  ids: string[],
): Promise<string[]> {
  if (ids.includes("-1")) return ["All projects"];
  if (ids.length === 0) return ["My projects"];
  const wanted = ids.slice(0, MAX_LISTED);
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.projects.list",
  ).listOrganizationProjects({
    path: { organization_id_or_slug: org },
    query: {
      query: wanted.map((id) => `id:${id}`).join(" "),
      per_page: MAX_LISTED,
    },
  });
  const data = sentryData(result, REFUSED, "project list");
  const parsed = data === null ? undefined : projectsSchema.safeParse(data);
  if (!parsed?.success) return [];
  const slugs = new Map(parsed.data.map(({ id, slug }) => [id, slug]));
  return wanted.flatMap((id) => {
    const slug = slugs.get(id);
    return slug ? [slug.slice(0, 160)] : [];
  });
}

async function readDashboardCard(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryDashboardLink,
): Promise<SentryDashboard | null> {
  const dashboard = await readDashboard(ctx, origin, link);
  if (!dashboard) return null;
  const filters = widgetFilters(dashboard, link);
  const queries = dashboard.widgets
    .flatMap((widget) => {
      const query = widgetChart(link.org, widget, dashboard, filters);
      return query ? [{ widget, query }] : [];
    })
    .slice(0, MAX_CHARTS);
  // Each chart is one query. A chart that Sentry refuses is left out.
  const [projects, charts] = await Promise.all([
    projectNames(ctx, origin, link.org, filters.project),
    Promise.all(
      queries.map(({ widget, query }) =>
        readWidgetChart(ctx, origin, query, widget.title),
      ),
    ),
  ]);
  return {
    title: text(dashboard.title, "Untitled dashboard"),
    widgetCount: dashboard.widgets.length,
    projects,
    environments: filters.environment
      .slice(0, MAX_LISTED)
      .map((name) => name.slice(0, 160)),
    range: rangeLabel(filters.range),
    widgets: dashboard.widgets.slice(0, MAX_WIDGETS).map((widget) => ({
      title: text(widget.title, "Untitled widget"),
      display: displayName(widget.displayType),
    })),
    charts: charts.flatMap((chart) =>
      chart
        ? [
            {
              ...chart,
              series: chart.series.slice(0, MAX_CHART_SERIES).map((series) => ({
                ...series,
                points: downsample(series.points, MAX_CHART_POINTS),
              })),
            },
          ]
        : [],
    ),
  };
}

async function readWidgetCard(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryDashboardLink,
): Promise<SentryChart | null> {
  const dashboard = await readDashboard(ctx, origin, link);
  const widget = dashboard?.widgets[link.widgetIndex!];
  if (!dashboard || !widget) return null;
  const query = widgetChart(
    link.org,
    widget,
    dashboard,
    widgetFilters(dashboard, link),
  );
  return query ? readWidgetChart(ctx, origin, query, widget.title) : null;
}

/** Read for this viewer, cached per viewer and URL. */
async function viewerRead<T>(
  ctx: ObjectLinkContext,
  url: URL,
  kind: "dashboard" | "widget",
  read: (origin: string, link: SentryDashboardLink) => Promise<T | null>,
): Promise<T | null> {
  const link = parseSentryDashboardLink(url);
  if (!link || (kind === "widget") !== (link.widgetIndex !== undefined)) {
    return null;
  }
  return ctx.cache.getOrLoad(
    `${kind}:${ctx.viewer.id}:${urlHash(url)}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await read(origin, link) : null;
      return { value, ttlMs: DASHBOARD_CACHE_TTL_MS };
    },
  );
}

function viewerDashboard(ctx: ObjectLinkContext, url: URL) {
  return viewerRead(ctx, url, "dashboard", (origin, link) =>
    readDashboardCard(ctx, origin, link),
  );
}

function viewerWidget(ctx: ObjectLinkContext, url: URL) {
  return viewerRead(ctx, url, "widget", (origin, link) =>
    readWidgetCard(ctx, origin, link),
  );
}

/**
 * Keep the facts within the limit: three significant digits, and fewer
 * chart points until they fit. Without room, the card has no charts.
 */
function dashboardFacts(dashboard: SentryDashboard): DashboardFacts {
  const facts: DashboardFacts = {
    type: "dashboard",
    widgetCount: dashboard.widgetCount,
    projects: dashboard.projects,
    environments: dashboard.environments,
    range: dashboard.range,
    widgets: dashboard.widgets,
    charts: [],
  };
  for (let size = MAX_CHART_POINTS; size >= 2; size = Math.floor(size / 2)) {
    const charts = dashboard.charts.flatMap((chart) => {
      const series = chart.series
        .filter((item) => item.points.length >= 2)
        .map((item) => ({
          label: text(item.label, "(no value)"),
          points: downsample(item.points, size).map((value) =>
            Number(value.toPrecision(3)),
          ),
        }));
      return series.length
        ? [{ title: chart.title, display: chart.display, series }]
        : [];
    });
    const sized = { ...facts, charts };
    if (objectFactsBytes(sized) <= OBJECT_FACTS_MAX_BYTES) return sized;
  }
  return facts;
}

async function resolveSentryDashboardLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const dashboard = await viewerDashboard(ctx, url);
  const link = parseSentryDashboardLink(url);
  if (!dashboard || !link) return undefined;
  return {
    kind: "object",
    objectType: "dashboard",
    key: `dashboard:${link.org}:${link.dashboardId}:${urlHash(url).slice(0, 16)}`,
    label: "Sentry dashboard",
    title: dashboard.title,
    url: url.href.length <= 2048 ? url.href : null,
    displayType: "Sentry dashboard",
    facts: dashboardFacts(dashboard),
  };
}

async function resolveSentryWidgetLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const chart = await viewerWidget(ctx, url);
  return chart ? chartCard(url, chart) : undefined;
}

/** Sentry dashboard links, on sentry.io and customer domains. */
export const sentryDashboardLinks: PluginObjectLinkDefinition = {
  canView: async (ctx, url) => (await viewerDashboard(ctx, url)) !== null,
  filters: SENTRY_DASHBOARD_LINK_FILTERS,
  objectTypes: ["dashboard"],
  resolve: resolveSentryDashboardLink,
};

/** Sentry dashboard widget links, shown as chart cards. */
export const sentryDashboardWidgetLinks: PluginObjectLinkDefinition = {
  canView: async (ctx, url) => (await viewerWidget(ctx, url)) !== null,
  filters: SENTRY_DASHBOARD_WIDGET_LINK_FILTERS,
  objectTypes: ["chart"],
  resolve: resolveSentryWidgetLink,
};
