/**
 * Link cards for one Sentry monitor: a metric alert, a cron job, or an
 * uptime check.
 *
 * The viewer's own Sentry account reads the monitor, so Sentry decides who
 * may see it. The result is cached per viewer and monitor for a minute:
 * `canView` reads the monitor, its project name, and its trend, and
 * `resolve` draws the card from the same entry. Junior's org read token
 * only finds the org's region host.
 *
 * The state comes from what Sentry returns: a metric alert or an uptime
 * check is failing while the issue it opened is unresolved, and a cron job
 * takes the worst state of its environments. A metric alert draws a trend
 * only when it queries spans, logs, or trace metrics, never a Discover
 * dataset. A cron job draws the run time of its last check-ins.
 */
import {
  objectSummary,
  type ObjectAnnotation,
  type ObjectFacts,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { sentryApi, sentryData } from "./api.js";
import {
  parseSentryMonitorLink,
  SENTRY_MONITOR_LINK_FILTERS,
  type SentryMonitorLink,
} from "./monitor-urls.js";
import { sentryRegionOrigin } from "./region.js";

type MonitorFacts = Extract<ObjectFacts, { type: "monitor" }>;

// The same time as the card cache.
const MONITOR_CACHE_TTL_MS = 60_000;
// Sentry refuses a monitor that the token may not read, or a bad id.
const REFUSED = [400, 401, 403, 404];
// Points in a trend: windows of a metric alert, or cron check-ins.
const TREND_POINTS = 48;

// Metric alerts on these datasets query spans, logs, or trace metrics.
// Any other dataset is Discover-backed, and draws no trend.
const EAP_DATASETS: Record<string, "spans" | "logs" | "tracemetrics"> = {
  trace_item_span: "spans",
  trace_item_log: "logs",
  trace_item_metric: "tracemetrics",
};

/** What a monitor card shows, read with the viewer's own token. */
interface SentryMonitor {
  name: string;
  status: string;
  facts: MonitorFacts;
}

const cronSchema = z.object({
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  isMuted: z.boolean().nullish(),
  config: z
    .object({
      schedule_type: z.string().nullish(),
      schedule: z.union([
        z.string(),
        z.array(z.union([z.number(), z.string()])),
      ]),
    })
    .partial()
    .nullish(),
  project: z.object({ slug: z.string() }).partial().nullish(),
  environments: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        isMuted: z.boolean().nullish(),
        lastCheckIn: z.string().nullish(),
      }),
    )
    .nullish(),
});

const snubaQuerySchema = z.object({
  dataset: z.string(),
  query: z.string().nullish(),
  aggregate: z.string(),
  timeWindow: z.number().int().positive(),
  environment: z.string().nullish(),
  eventTypes: z.array(z.string()).nullish(),
});

const detectorSchema = z.object({
  name: z.string(),
  type: z.string(),
  enabled: z.boolean().nullish(),
  description: z.string().nullish(),
  projectId: z.string().nullish(),
  config: z.object({ environment: z.string().nullish() }).partial().nullish(),
  latestGroup: z
    .object({
      status: z.string(),
      project: z.object({ slug: z.string() }).partial().nullish(),
    })
    .nullish(),
  dataSources: z
    .array(
      z.object({
        type: z.string(),
        queryObj: z.unknown(),
      }),
    )
    .nullish(),
});

const uptimeSchema = z.object({
  url: z.string(),
  method: z.string().nullish(),
});

const timeseriesSchema = z.object({
  timeSeries: z.array(
    z.object({
      values: z.array(z.object({ value: z.number().nullable() }).loose()),
    }),
  ),
});

const checkInsSchema = z.array(
  z.object({ duration: z.number().nullable() }).loose(),
);

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

function isoTime(value: string | null | undefined): string | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function trendOf(
  label: string,
  points: (number | null)[],
): MonitorFacts["trend"] {
  const values = points.map((value) => Math.max(0, value ?? 0));
  return values.length >= 2
    ? { label: label.slice(0, 160), points: values.slice(-TREND_POINTS) }
    : undefined;
}

function cronSchedule(
  config: z.infer<typeof cronSchema>["config"],
): string | undefined {
  const schedule = config?.schedule;
  if (typeof schedule === "string") return text(schedule);
  const [count, unit] = schedule ?? [];
  return typeof count === "number" && typeof unit === "string"
    ? `Every ${count} ${unit}${count === 1 ? "" : "s"}`
    : undefined;
}

// A cron job takes the worst state of its environments. An environment
// without a check-in yet is "active".
function cronState(
  cron: z.infer<typeof cronSchema>,
): Pick<SentryMonitor, "status"> & Pick<MonitorFacts, "state"> {
  const environments = cron.environments ?? [];
  if (cron.status !== "active") return { status: "Disabled", state: "paused" };
  if (cron.isMuted) return { status: "Muted", state: "paused" };
  if (environments.some((environment) => environment.status === "error")) {
    return { status: "Failing", state: "failing" };
  }
  if (environments.some((environment) => environment.status === "ok")) {
    return { status: "OK", state: "ok" };
  }
  return { status: "Waiting", state: "pending" };
}

/** Read the run time of a cron job's last check-ins. */
async function readCronTrend(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  slug: string,
): Promise<MonitorFacts["trend"]> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.monitor_checkins.list",
  ).listOrganizationMonitorCheckins({
    path: { organization_id_or_slug: org, monitor_id_or_slug: slug },
  });
  const data = sentryData(result, REFUSED, "check-in read");
  const parsed = data === null ? undefined : checkInsSchema.safeParse(data);
  if (!parsed?.success) return undefined;
  // Sentry lists the newest check-in first.
  const durations = parsed.data
    .slice(0, TREND_POINTS)
    .map(({ duration }) => duration)
    .reverse();
  return trendOf(
    `Run time (ms), last ${durations.length} check-ins`,
    durations,
  );
}

async function cronMonitor(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  cron: z.infer<typeof cronSchema>,
): Promise<SentryMonitor> {
  const environments = (cron.environments ?? []).map(({ name }) => name);
  const lastCheckIns = (cron.environments ?? [])
    .map(({ lastCheckIn }) => isoTime(lastCheckIn))
    .filter((time) => time !== undefined)
    .sort();
  const state = cronState(cron);
  return {
    name: cron.name,
    status: state.status,
    facts: {
      type: "monitor",
      kind: "cron",
      state: state.state,
      project: text(cron.project?.slug),
      environment: text(environments.join(", ")),
      detail: cronSchedule(cron.config),
      lastCheckedAt: lastCheckIns.at(-1),
      trend: await readCronTrend(ctx, origin, org, cron.slug),
    },
  };
}

/** Read the windows of a metric alert that queries spans, logs, or metrics. */
async function readMetricTrend(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  projectId: string | undefined,
  query: z.infer<typeof snubaQuerySchema>,
): Promise<MonitorFacts["trend"]> {
  const dataset =
    query.dataset === "events_analytics_platform"
      ? (query.eventTypes ?? []).map((type) => EAP_DATASETS[type]).find(Boolean)
      : undefined;
  if (!dataset) return undefined;
  const minutes = Math.max(1, Math.round(query.timeWindow / 60));
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.events_timeseries.get",
  ).listOrganizationEventsTimeseries({
    path: { organization_id_or_slug: org },
    query: {
      dataset,
      yAxis: [query.aggregate],
      interval: `${minutes}m`,
      statsPeriod: `${minutes * TREND_POINTS}m`,
      ...(projectId ? { project: [Number(projectId)] } : undefined),
      ...(query.environment ? { environment: [query.environment] } : undefined),
      ...(query.query ? { query: query.query } : undefined),
    },
  });
  const data = sentryData(result, REFUSED, "metric alert query");
  const parsed = data === null ? undefined : timeseriesSchema.safeParse(data);
  const series = parsed?.success ? parsed.data.timeSeries[0] : undefined;
  if (!series) return undefined;
  const hours = (minutes * TREND_POINTS) / 60;
  return trendOf(
    `${query.aggregate}, last ${hours < 1 ? `${minutes * TREND_POINTS} min` : `${Number(hours.toPrecision(3))} h`}`,
    series.values.map(({ value }) => value),
  );
}

/** Name the project of a monitor that only holds its id. */
async function readProjectSlug(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  projectId: string,
): Promise<string | undefined> {
  const result = await sentryApi(
    ctx.viewerEgress,
    origin,
    "sentry.projects.list",
  ).listOrganizationProjects({
    path: { organization_id_or_slug: org },
    query: { query: `id:${projectId}` },
  });
  const data = sentryData(result, REFUSED, "project read");
  const parsed =
    data === null
      ? undefined
      : z.array(z.object({ id: z.string(), slug: z.string() })).safeParse(data);
  return parsed?.success
    ? parsed.data.find(({ id }) => id === projectId)?.slug
    : undefined;
}

// A metric alert or an uptime check fails while its issue is unresolved.
function issueState(
  detector: z.infer<typeof detectorSchema>,
  failing: string,
  ok: string,
): Pick<SentryMonitor, "status"> & Pick<MonitorFacts, "state"> {
  if (detector.enabled === false)
    return { status: "Disabled", state: "paused" };
  return detector.latestGroup?.status === "unresolved"
    ? { status: failing, state: "failing" }
    : { status: ok, state: "ok" };
}

async function detectorMonitor(
  ctx: ObjectLinkContext,
  origin: string,
  org: string,
  detector: z.infer<typeof detectorSchema>,
): Promise<SentryMonitor | null> {
  const source = detector.dataSources?.[0]?.queryObj;
  if (detector.type === "monitor_check_in_failure") {
    const cron = cronSchema.safeParse(source);
    if (!cron.success) return null;
    const monitor = await cronMonitor(ctx, origin, org, cron.data);
    if (detector.enabled !== false) return monitor;
    return {
      ...monitor,
      status: "Disabled",
      facts: { ...monitor.facts, state: "paused" },
    };
  }
  const projectId = detector.projectId ?? undefined;
  const project = async () =>
    text(detector.latestGroup?.project?.slug) ??
    (projectId
      ? await readProjectSlug(ctx, origin, org, projectId)
      : undefined);
  const summary = text(detector.description);
  if (detector.type === "metric_issue") {
    const query = snubaQuerySchema.safeParse(
      z.object({ snubaQuery: z.unknown() }).safeParse(source).data?.snubaQuery,
    );
    if (!query.success) return null;
    const minutes = Math.max(1, Math.round(query.data.timeWindow / 60));
    const state = issueState(detector, "Alerting", "OK");
    const [projectSlug, trend] = await Promise.all([
      project(),
      readMetricTrend(ctx, origin, org, projectId, query.data),
    ]);
    return {
      name: detector.name,
      status: state.status,
      facts: {
        type: "monitor",
        summary: summary && objectSummary(summary),
        kind: "metric",
        state: state.state,
        project: projectSlug,
        environment: text(query.data.environment),
        detail: text(`${query.data.aggregate} per ${minutes} min`),
        trend,
      },
    };
  }
  if (detector.type === "uptime_domain_failure") {
    const uptime = uptimeSchema.safeParse(source);
    if (!uptime.success) return null;
    const target = URL.parse(uptime.data.url);
    const state = issueState(detector, "Down", "Up");
    return {
      name: detector.name,
      status: state.status,
      facts: {
        type: "monitor",
        summary: summary && objectSummary(summary),
        kind: "uptime",
        state: state.state,
        project: await project(),
        environment: text(detector.config?.environment),
        // The query string can hold a token, so the card leaves it out.
        detail: target
          ? text(
              `${uptime.data.method ?? "GET"} ${target.origin}${target.pathname}`,
            )
          : undefined,
      },
    };
  }
  // Error and issue stream monitors check no schedule, so they get no card.
  return null;
}

/** Read the monitor with the viewer's token. Nothing when Sentry refuses. */
async function readMonitor(
  ctx: ObjectLinkContext,
  origin: string,
  link: SentryMonitorLink,
): Promise<SentryMonitor | null> {
  const api = sentryApi(ctx.viewerEgress, origin, "sentry.monitor.get");
  if ("cronSlug" in link) {
    const result = await api.getOrganizationMonitor({
      path: {
        organization_id_or_slug: link.org,
        monitor_id_or_slug: link.cronSlug,
      },
    });
    const data = sentryData(result, REFUSED, "cron read");
    const parsed = data === null ? undefined : cronSchema.safeParse(data);
    return parsed?.success
      ? cronMonitor(ctx, origin, link.org, parsed.data)
      : null;
  }
  const result = await api.getOrganizationDetector({
    path: { organization_id_or_slug: link.org, detector_id: link.detectorId },
  });
  const data = sentryData(result, REFUSED, "monitor read");
  const parsed = data === null ? undefined : detectorSchema.safeParse(data);
  return parsed?.success
    ? detectorMonitor(ctx, origin, link.org, parsed.data)
    : null;
}

function monitorKey(link: SentryMonitorLink): string {
  return "cronSlug" in link
    ? `${link.org}:cron:${link.cronSlug}`
    : `${link.org}:${link.detectorId}`;
}

/** Read the monitor for this viewer, cached per viewer and monitor. */
async function viewerMonitor(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<{ link: SentryMonitorLink; monitor: SentryMonitor } | null> {
  const link = parseSentryMonitorLink(url);
  if (!link) return null;
  const monitor = await ctx.cache.getOrLoad(
    `monitor:${ctx.viewer.id}:${monitorKey(link)}`,
    async () => {
      const origin = await sentryRegionOrigin(ctx, link.org);
      const value = origin ? await readMonitor(ctx, origin, link) : null;
      return { value, ttlMs: MONITOR_CACHE_TTL_MS };
    },
  );
  return monitor && { link, monitor };
}

async function canViewSentryMonitorLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  return (await viewerMonitor(ctx, url)) !== null;
}

async function resolveSentryMonitorLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const read = await viewerMonitor(ctx, url);
  if (!read) return undefined;
  const { link, monitor } = read;
  return {
    kind: "object",
    objectType: "monitor",
    key: `monitor:${monitorKey(link)}`,
    label: monitor.name.slice(0, 160),
    title: monitor.name.slice(0, 512),
    url: url.href.length <= 2048 ? url.href : null,
    status: monitor.status,
    displayType: "Sentry monitor",
    facts: monitor.facts,
  };
}

/** Sentry monitor links, on sentry.io and customer domains. */
export const sentryMonitorLinks: PluginObjectLinkDefinition = {
  canView: canViewSentryMonitorLink,
  filters: SENTRY_MONITOR_LINK_FILTERS,
  objectType: "monitor",
  resolve: resolveSentryMonitorLink,
};
