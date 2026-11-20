import type { CacheHealthReport } from "@sentry/junior/api/schema";
import { CartesianGrid, Line, LineChart } from "recharts";

import { useCacheHealth } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { StatusChip } from "../../components/StatusChip";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { StatTile } from "../../components/metrics/StatTile";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatCompactNumber, formatCostBreakdown } from "../../format";
import { formatTime } from "../../time";

type Report = Extract<CacheHealthReport, { status: "ok" }>;
type Calls = Report["lastWeek"];

const WRITE_SHARE_COLOR = "var(--color-amber-300)";
const REWRITE_COLOR = "var(--color-rose-400)";
const chartConfig = {
  writeShare: { color: WRITE_SHARE_COLOR, label: "Write share" },
  fullRewriteRate: { color: REWRITE_COLOR, label: "Full-rewrite rate" },
};
const legend = [
  { color: WRITE_SHARE_COLOR, key: "writeShare", label: "Write share" },
  { color: REWRITE_COLOR, key: "fullRewriteRate", label: "Full-rewrite rate" },
];

const share = (part: number, whole: number) =>
  whole > 0 ? part / whole : null;
const percent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const usd = (value: number) => formatCostBreakdown({ total: value });
// A label for a telemetry key, such as `Unlikely return` for
// `unlikely_return`.
const words = (key: string) => {
  const text = key.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const writeShare = (calls: Calls) =>
  share(calls.cacheWriteTokens, calls.inputTokens);

/**
 * Show whether agent model calls read the prompt cache, and what warming did,
 * in the last 24 hours or 7 days. The server reads it from Junior's own Sentry
 * telemetry. Longer ranges show the last 7 days.
 */
export function CacheHealth(props: { range: TimeRangeDays }) {
  const query = useCacheHealth(props.range === 1 ? "24h" : "7d");
  // A plain type: React Query's data type does not narrow by `status`.
  const data: CacheHealthReport | undefined = query.data;
  const report = data?.status === "ok" ? data : undefined;
  return (
    <section aria-label="Cache health">
      <Card>
        <div className="border-b border-dashboard-border-subtle px-4 py-4 sm:px-5">
          <SectionTitle>Cache health</SectionTitle>
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Prompt cache of agent calls
            {report ? ` to ${report.modelId}` : ""}, without warmups. Write
            share is cache writes over input tokens. A full rewrite wrote over
            50k tokens to the cache and read under 20k.
            {props.range > 7 ? " Shows the last 7 days." : ""}
            {report?.stale
              ? ` Sentry is limiting reads, so this is from ${formatTime(report.fetchedAt, { hour: "numeric", minute: "2-digit" })}.`
              : ""}
          </p>
          {report ? <HealthTotals report={report} /> : null}
        </div>
        {report ? (
          <>
            <HealthChart buckets={report.buckets} />
            <Outcomes report={report} />
          </>
        ) : (
          <EmptyTelemetry>
            {query.error
              ? "Cache health failed to load."
              : data && data.status !== "ok"
                ? unavailable(data)
                : "Loading cache health."}
          </EmptyTelemetry>
        )}
      </Card>
    </section>
  );
}

function unavailable(report: Exclude<CacheHealthReport, Report>): string {
  if (report.status === "unconfigured") {
    return `Set ${report.missing.join(", ")} to read cache health from Sentry. The read token needs Issue & Event read access.`;
  }
  if (report.status === "denied") {
    return "Sentry rejected SENTRY_READ_TOKEN. It needs Issue & Event read access to this project.";
  }
  return "Sentry is limiting reads. Cache health shows again in a minute.";
}

function HealthTotals(props: { report: Report }) {
  const { report } = props;
  const totals = report.buckets.reduce(
    (sum, bucket) => ({
      calls: sum.calls + bucket.calls,
      inputTokens: sum.inputTokens + bucket.inputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + bucket.cacheWriteTokens,
      fullRewrites: sum.fullRewrites + bucket.fullRewrites,
    }),
    { calls: 0, inputTokens: 0, cacheWriteTokens: 0, fullRewrites: 0 },
  );
  const current = writeShare(totals);
  const lastWeek = writeShare(report.lastWeek);
  const sent = Object.values(report.warmups.sentByTurnEnding).reduce(
    (sum, count) => sum + count,
    0,
  );
  const net = report.idlePeriods.savedUsd - report.warmups.costUsd;
  return (
    <>
      <Breakers breakers={report.breakers} />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label={`Write share, ${percent(lastWeek)} last week`}
          value={percent(current)}
          valueClassName={
            // Up by over half on last week's.
            current !== null && lastWeek !== null && current > lastWeek * 1.5
              ? "text-amber-100"
              : undefined
          }
        />
        <StatTile
          label={`Full rewrites, ${formatCompactNumber(totals.fullRewrites)} of ${formatCompactNumber(totals.calls)} calls`}
          value={percent(share(totals.fullRewrites, totals.calls))}
        />
        <StatTile
          label={`Warmups sent, ${usd(report.warmups.costUsd)}`}
          value={formatCompactNumber(sent)}
        />
        <StatTile
          label={`Net savings, ${usd(report.idlePeriods.savedUsd)} saved`}
          value={usd(net)}
          valueClassName={net < 0 ? "text-rose-100" : "text-emerald-100"}
        />
      </div>
    </>
  );
}

function Breakers(props: { breakers: Report["breakers"] }) {
  if (!props.breakers.length) return null;
  return (
    <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
      {props.breakers.map((breaker) => (
        <li key={breaker.provider}>
          <StatusChip
            size="compact"
            tone={breaker.open ? "warning" : "success"}
          >
            {breaker.provider} warming {breaker.open ? "paused" : "on"}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

function HealthChart(props: { buckets: Report["buckets"] }) {
  const data = props.buckets.map((bucket) => ({
    date: bucket.start,
    calls: bucket.calls,
    fullRewrites: bucket.fullRewrites,
    fullRewriteRate: share(bucket.fullRewrites, bucket.calls),
    writeShare: writeShare(bucket),
  }));
  const shares = data.flatMap((bucket) =>
    [bucket.writeShare, bucket.fullRewriteRate].flatMap((value) =>
      value === null ? [] : [value],
    ),
  );
  // Round the top up to a tenth, so a quiet window does not fill the chart.
  const maximum = Math.max(0.1, Math.ceil(Math.max(0, ...shares) * 10) / 10);
  return (
    <div className="relative px-2 py-3 sm:px-4 sm:py-4">
      <div className="px-2 pb-2">
        <ChartLegend
          ariaLabel="Cache health chart legend"
          inline
          items={legend}
        />
      </div>
      <ChartContainer className="aspect-auto h-44 w-full" config={chartConfig}>
        <LineChart
          aria-label="Prompt cache write share and full-rewrite rate over time"
          data={data}
          margin={activityChartMargin}
          role="img"
        >
          <CartesianGrid strokeDasharray="3 5" vertical={false} />
          <ActivityChartYAxis format={percent} maximum={maximum} />
          <ActivityChartXAxis keys={data.map((bucket) => bucket.date)} />
          <ChartTooltip
            content={
              <ActivityChartTooltipContent
                rows={(bucket: (typeof data)[number]) => [
                  ["write share", percent(bucket.writeShare)],
                  [
                    "full rewrites",
                    `${formatCompactNumber(bucket.fullRewrites)} of ${formatCompactNumber(bucket.calls)}`,
                  ],
                ]}
              />
            }
          />
          {legend.map((series) => (
            <Line
              connectNulls={false}
              dataKey={series.key}
              dot={false}
              isAnimationActive={false}
              key={series.key}
              stroke={series.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              type="linear"
            />
          ))}
        </LineChart>
      </ChartContainer>
      {data.every((bucket) => bucket.calls === 0) ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
          No agent model calls in this period.
        </div>
      ) : null}
    </div>
  );
}

function Outcomes(props: { report: Report }) {
  const { idlePeriods, warmups, breakerEvents } = props.report;
  const groups = [
    {
      label: "Idle periods",
      counts: {
        saved: idlePeriods.saved,
        "not warmed": idlePeriods.notWarmed,
        "warming stopped early": idlePeriods.stoppedEarly,
        "cache lost": idlePeriods.cacheLost,
      },
    },
    { label: "Warmups sent after", counts: warmups.sentByTurnEnding },
    { label: "Warmups skipped", counts: warmups.skipReasons },
    {
      label: "Breaker",
      counts: {
        opened: breakerEvents.opened,
        "closed by an admin": breakerEvents.closed,
      },
    },
  ];
  return (
    <div className="grid gap-4 border-t border-dashboard-border-subtle px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
      {groups.map((group) => (
        <OutcomeCounts
          counts={group.counts}
          key={group.label}
          label={group.label}
        />
      ))}
    </div>
  );
}

function OutcomeCounts(props: {
  counts: Record<string, number>;
  label: string;
}) {
  const rows = Object.entries(props.counts)
    .filter(([, count]) => count > 0)
    .sort(([, left], [, right]) => right - left);
  return (
    <div className="min-w-0">
      <div className="font-sans text-xs font-medium text-dashboard-text-muted">
        {props.label}
      </div>
      {rows.length ? (
        <dl className="m-0 mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-sans text-xs">
          {rows.map(([key, count]) => (
            <div className="contents" key={key}>
              <dt className="min-w-0 truncate text-dashboard-text">
                {words(key)}
              </dt>
              <dd className="m-0 text-right tabular-nums text-dashboard-text">
                {formatCompactNumber(count)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="m-0 mt-2 font-sans text-xs text-dashboard-text-muted">
          None
        </p>
      )}
    </div>
  );
}
