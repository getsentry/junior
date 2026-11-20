import type { ListOrganizationEventsData } from "@sentry/api";
import * as z from "zod";
import { breakerStates, connectedState } from "@/chat/cache-warming/request";
import { botConfig } from "@/chat/config";
import { mapBounded } from "@/chat/fan-out";
import {
  sentryTelemetry,
  telemetryResponse,
  type SentryTelemetry,
  type SentryTelemetryResponse,
} from "@/chat/sentry-telemetry";
import type { CacheHealthReport } from "../schema/cache-warming";

type CacheHealthWindow = "24h" | "7d";
type CacheHealthData = Extract<CacheHealthReport, { status: "ok" }>;
// The part of the report that comes from Sentry, and is shared for a minute.
type SentryHealth = Omit<CacheHealthData, "breakers">;

const HOUR_MS = 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const WINDOWS = {
  "24h": { ms: 24 * HOUR_MS, interval: "1h" },
  "7d": { ms: WEEK_MS, interval: "6h" },
} as const;
// Page loads within this time share one answer. Sentry rate limits its
// events API, so loads must not each read it.
const FRESH_MS = 60_000;
// A rate limited read serves an answer up to this old, marked stale.
const STALE_MS = 60 * 60 * 1_000;
// Sentry allows few events reads at once per org.
const READ_CONCURRENCY = 2;

const cacheKey = (window: CacheHealthWindow) =>
  `junior:cache_warming:health:${window}`;

const tableSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});
const timeseriesSchema = z.object({
  timeSeries: z.array(
    z.object({
      yAxis: z.string(),
      values: z.array(
        z.object({ timestamp: z.number(), value: z.number().nullable() }),
      ),
    }),
  ),
});

// Agent loop calls have no prompt name. Warmups and other model calls do.
const agentCalls = (modelId: string) =>
  `span.op:gen_ai.chat !has:gen_ai.prompt.name gen_ai.request.model:"${modelId}"`;
const FULL_REWRITE =
  "gen_ai.usage.cache_creation.input_tokens:>50000 gen_ai.usage.cache_read.input_tokens:<20000";
const CALL_AGGREGATES = [
  "count()",
  "sum(gen_ai.usage.input_tokens)",
  "sum(gen_ai.usage.cache_creation.input_tokens)",
];
const IDLE_PERIOD_METRIC =
  "cache_warming.idle_period.saved_usd,distribution,none";
const BREAKER_METRIC = "sum(value,cache_warming.breaker,counter,none)";

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
const usd = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const label = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const bucketKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);

type Read = () => Promise<SentryTelemetryResponse<unknown>>;

// The Sentry reads of one window, in the order that `healthData` reads them.
function windowReads(
  telemetry: SentryTelemetry,
  window: CacheHealthWindow,
  nowMs: number,
): Read[] {
  const { client, org, projectId } = telemetry;
  const { ms, interval } = WINDOWS[window];
  const calls = agentCalls(botConfig.modelId);
  const path = { organization_id_or_slug: org };
  const timeseries =
    (query: string, yAxis: string[]): Read =>
    async () =>
      telemetryResponse(
        await client.listOrganizationEventsTimeseries({
          path,
          query: {
            dataset: "spans",
            project: [projectId],
            statsPeriod: window,
            interval,
            query,
            yAxis,
          },
        }),
        "events-timeseries",
      );
  const table =
    (query: Omit<ListOrganizationEventsData["query"], "project">): Read =>
    async () =>
      telemetryResponse(
        await client.listOrganizationEvents({
          path,
          query: { ...query, project: [projectId] },
        }),
        "events",
      );
  return [
    timeseries(calls, CALL_AGGREGATES),
    timeseries(`${calls} ${FULL_REWRITE}`, ["count()"]),
    table({
      dataset: "spans",
      start: new Date(nowMs - WEEK_MS - ms).toISOString(),
      end: new Date(nowMs - WEEK_MS).toISOString(),
      query: calls,
      field: CALL_AGGREGATES,
    }),
    table({
      statsPeriod: window,
      dataset: "spans",
      query: "span.op:cache_warming.warmup",
      field: [
        "app.cache_warming.trigger",
        "app.cache_warming.outcome",
        "app.cache_warming.turn_ending",
        "app.cache_warming.skip_reason",
        "count()",
        "sum(app.cost.total_usd)",
      ],
      per_page: 100,
    }),
    table({
      statsPeriod: window,
      dataset: "tracemetrics",
      field: [
        "app.cache_warming.idle_outcome",
        `count(value,${IDLE_PERIOD_METRIC})`,
        `sum(value,${IDLE_PERIOD_METRIC})`,
      ],
    }),
    table({
      statsPeriod: window,
      dataset: "tracemetrics",
      field: ["app.cache_warming.breaker_event", BREAKER_METRIC],
    }),
  ];
}

// The values of one axis of a timeseries read, by bucket start.
function series(body: unknown, axis: string): Map<number, number | null> {
  const values =
    timeseriesSchema.parse(body).timeSeries.find((item) => item.yAxis === axis)
      ?.values ?? [];
  return new Map(values.map((point) => [point.timestamp, point.value]));
}

function callTotals(row: Record<string, unknown> | undefined) {
  return {
    calls: count(row?.["count()"]),
    inputTokens: count(row?.["sum(gen_ai.usage.input_tokens)"]),
    cacheWriteTokens: count(
      row?.["sum(gen_ai.usage.cache_creation.input_tokens)"],
    ),
  };
}

function warmupTotals(body: unknown): CacheHealthData["warmups"] {
  const sentByTurnEnding: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  let costUsd = 0;
  for (const row of tableSchema.parse(body).data) {
    const rows = count(row["count()"]);
    costUsd += usd(row["sum(app.cost.total_usd)"]);
    const outcome = label(row["app.cache_warming.outcome"]);
    if (outcome === "skipped") {
      const reason = label(row["app.cache_warming.skip_reason"]) ?? "unknown";
      skipReasons[reason] = (skipReasons[reason] ?? 0) + rows;
    } else if (outcome === "completed" || outcome === "missed") {
      const ending =
        label(row["app.cache_warming.trigger"]) === "tool_wait"
          ? "tool_wait"
          : (label(row["app.cache_warming.turn_ending"]) ?? "unknown");
      sentByTurnEnding[ending] = (sentByTurnEnding[ending] ?? 0) + rows;
    }
  }
  return { sentByTurnEnding, skipReasons, costUsd };
}

function idlePeriodTotals(body: unknown): CacheHealthData["idlePeriods"] {
  const byOutcome = new Map(
    tableSchema
      .parse(body)
      .data.map((row) => [label(row["app.cache_warming.idle_outcome"]), row]),
  );
  const periods = (outcome: string) =>
    count(byOutcome.get(outcome)?.[`count(value,${IDLE_PERIOD_METRIC})`]);
  return {
    saved: periods("saved"),
    notWarmed: periods("not_warmed"),
    stoppedEarly: periods("stopped_early"),
    cacheLost: periods("cache_lost"),
    savedUsd: usd(byOutcome.get("saved")?.[`sum(value,${IDLE_PERIOD_METRIC})`]),
  };
}

function breakerEventTotals(body: unknown): CacheHealthData["breakerEvents"] {
  const rows = tableSchema.parse(body).data;
  const events = (event: string) =>
    count(
      rows.find((row) => row["app.cache_warming.breaker_event"] === event)?.[
        BREAKER_METRIC
      ],
    );
  return { opened: events("opened"), closed: events("closed") };
}

// Build the report from the Sentry answers of `windowReads`.
function healthData(
  window: CacheHealthWindow,
  bodies: unknown[],
  nowMs: number,
): SentryHealth {
  const [callBody, rewriteBody, lastWeek, warmups, idlePeriods, breakers] =
    bodies;
  const [calls, inputTokens, cacheWriteTokens] = CALL_AGGREGATES.map((axis) =>
    series(callBody, axis),
  );
  const rewrites = series(rewriteBody, "count()");
  return {
    status: "ok",
    window,
    modelId: botConfig.modelId,
    fetchedAt: new Date(nowMs).toISOString(),
    stale: false,
    buckets: [...(calls ?? [])].map(([timestamp, value]) => ({
      start: bucketKey(timestamp),
      calls: count(value),
      inputTokens: count(inputTokens?.get(timestamp)),
      cacheWriteTokens: count(cacheWriteTokens?.get(timestamp)),
      fullRewrites: count(rewrites.get(timestamp)),
    })),
    lastWeek: callTotals(tableSchema.parse(lastWeek).data[0]),
    warmups: warmupTotals(warmups),
    idlePeriods: idlePeriodTotals(idlePeriods),
    breakerEvents: breakerEventTotals(breakers),
  };
}

// Read one window from Sentry. A read that Sentry rate limited or denied
// stops the report.
async function readWindow(
  telemetry: SentryTelemetry,
  window: CacheHealthWindow,
  nowMs: number,
): Promise<SentryHealth | { status: "rate_limited" | "denied" }> {
  const answers = await mapBounded(
    windowReads(telemetry, window, nowMs),
    (read) => read(),
    READ_CONCURRENCY,
  );
  const bodies: unknown[] = [];
  for (const answer of answers) {
    if (answer.status !== "ok") return { status: answer.status };
    bodies.push(answer.data);
  }
  return healthData(window, bodies, nowMs);
}

/** Report whether warming is paused for each provider of the warmed models. */
export async function warmedBreakerStates() {
  // Only the agent model and its refusal fallback are warmed.
  return await breakerStates(await connectedState(), [
    botConfig.modelId,
    ...(botConfig.refusalFallbackModelId
      ? [botConfig.refusalFallbackModelId]
      : []),
  ]);
}

/**
 * Read the cache health of the last 24 hours or 7 days from Junior's own
 * Sentry telemetry. Page loads within a minute share one answer through the
 * state adapter. When Sentry rate limits a read, an answer up to an hour old
 * is served, marked stale. The breaker state is always live.
 */
export async function readCacheHealth(
  window: CacheHealthWindow,
  nowMs = Date.now(),
): Promise<CacheHealthReport> {
  const telemetry = sentryTelemetry();
  if ("missing" in telemetry) {
    return { status: "unconfigured", missing: telemetry.missing };
  }
  const state = await connectedState();
  const cached = await state.get<SentryHealth>(cacheKey(window));
  let health: SentryHealth;
  if (cached && nowMs - Date.parse(cached.fetchedAt) < FRESH_MS) {
    health = cached;
  } else {
    const read = await readWindow(telemetry, window, nowMs);
    if (read.status === "ok") {
      await state.set(cacheKey(window), read, STALE_MS);
      health = read;
    } else if (read.status === "rate_limited" && cached) {
      health = { ...cached, stale: true };
    } else {
      return { status: read.status };
    }
  }
  return { ...health, breakers: await warmedBreakerStates() };
}
