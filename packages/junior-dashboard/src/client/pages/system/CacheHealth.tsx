import type { CacheWarmingHourlyReport } from "@sentry/junior/api/schema";
import { CartesianGrid, Line, LineChart } from "recharts";

import { useCacheWarmingHourly } from "../../api";
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
import { formatCompactNumber } from "../../format";
import { formatTime } from "../../time";
import { cacheWarmingHours } from "./CacheWarmingSavings";

type Report = CacheWarmingHourlyReport;
type ModelCache = Report["totals"]["modelCache"];

const WRITE_SHARE_COLOR = "var(--color-amber-300)";
const REWRITE_COLOR = "var(--color-rose-400)";
const chartConfig = {
  writeShare: { color: WRITE_SHARE_COLOR, label: "Write share" },
  fullRewriteRate: { color: REWRITE_COLOR, label: "Full-rewrite rate" },
};
const legend = [
  { color: WRITE_SHARE_COLOR, key: "writeShare", label: "Write share" },
  {
    color: REWRITE_COLOR,
    key: "fullRewriteRate",
    label: "Full-rewrite rate",
  },
];

const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const words = (key: string) => key.replaceAll("_", " ");

/**
 * Show whether agent model calls read the prompt cache, per hour, and what
 * happened to warmups: sent, skipped and why, and the breaker. Write share
 * compares with the same window a week earlier. Longer ranges show the last
 * 7 days, which is as far as the hourly counters reach with a comparison.
 */
export function CacheHealth(props: { range: TimeRangeDays }) {
  const query = useCacheWarmingHourly(cacheWarmingHours(props.range));
  return (
    <section aria-label="Cache health">
      <Card>
        <div className="border-b border-dashboard-border-subtle px-4 py-4 sm:px-5">
          <SectionTitle>Cache health</SectionTitle>
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Prompt cache of agent calls, without warmups. Write share is cache
            writes over input tokens. A full rewrite wrote over 50k tokens to
            the cache and read under 20k.
            {props.range > 7 ? " Hourly counters show the last 7 days." : ""}
          </p>
          {query.data ? <HealthTotals report={query.data} /> : null}
        </div>
        {query.data ? (
          <>
            <HealthChart hours={query.data.hours} />
            <Outcomes report={query.data} />
          </>
        ) : (
          <EmptyTelemetry>
            {query.error
              ? "Cache health failed to load."
              : "Loading cache health."}
          </EmptyTelemetry>
        )}
      </Card>
    </section>
  );
}

function HealthTotals(props: { report: Report }) {
  const { modelCache, warmups } = props.report.totals;
  const lastWeek = props.report.lastWeek.modelCache;
  return (
    <>
      <Breakers breakers={props.report.breakers} />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label={`Write share, ${percent(lastWeek.writeShare)} last week`}
          value={percent(modelCache.writeShare)}
          valueClassName={
            worse(modelCache, lastWeek) ? "text-amber-100" : undefined
          }
        />
        <StatTile
          label={`Full rewrites, ${formatCompactNumber(modelCache.fullRewrites)} of ${formatCompactNumber(modelCache.calls)} calls`}
          value={percent(modelCache.fullRewriteRate)}
        />
        <StatTile
          label={`Warmups sent, ${formatCompactNumber(warmups.missed)} missed`}
          value={formatCompactNumber(warmups.sent)}
        />
        <StatTile
          label="Warmed periods that still wrote"
          value={formatCompactNumber(warmups.warmedRewrites)}
        />
      </div>
    </>
  );
}

// Write share up by over half on last week's.
function worse(current: ModelCache, lastWeek: ModelCache): boolean {
  if (current.writeShare === null || lastWeek.writeShare === null) {
    return false;
  }
  return current.writeShare > lastWeek.writeShare * 1.5;
}

function Breakers(props: { breakers: Report["breakers"] }) {
  if (!props.breakers.length) return null;
  const time = (iso: string) =>
    formatTime(iso, {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
    });
  return (
    <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-5 gap-y-1 p-0">
      {props.breakers.map((breaker) => (
        <li
          className="flex flex-wrap items-baseline gap-x-2 font-sans text-xs text-dashboard-text-muted"
          key={breaker.provider}
        >
          <StatusChip
            size="compact"
            tone={breaker.open ? "warning" : "success"}
          >
            {breaker.provider} warming {breaker.open ? "paused" : "on"}
          </StatusChip>
          {breaker.open && breaker.lastOpenedAt ? (
            <span>since {time(breaker.lastOpenedAt)}</span>
          ) : breaker.lastOpenedAt ? (
            <span>
              last paused {time(breaker.lastOpenedAt)}
              {breaker.lastClosedAt ? ` to ${time(breaker.lastClosedAt)}` : ""}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function HealthChart(props: { hours: Report["hours"] }) {
  const data = props.hours.map((hour) => ({
    date: hour.hour.slice(0, 13),
    calls: hour.modelCache.calls,
    fullRewrites: hour.modelCache.fullRewrites,
    fullRewriteRate: hour.modelCache.fullRewriteRate,
    writeShare: hour.modelCache.writeShare,
  }));
  const shares = data.flatMap((hour) =>
    [hour.writeShare, hour.fullRewriteRate].flatMap((value) =>
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
          aria-label="Prompt cache write share and full-rewrite rate per hour"
          data={data}
          margin={activityChartMargin}
          role="img"
        >
          <CartesianGrid strokeDasharray="3 5" vertical={false} />
          <ActivityChartYAxis
            format={(value) => percent(value)}
            maximum={maximum}
          />
          <ActivityChartXAxis keys={data.map((hour) => hour.date)} />
          <ChartTooltip
            content={
              <ActivityChartTooltipContent
                rows={(hour: (typeof data)[number]) => [
                  ["write share", percent(hour.writeShare)],
                  [
                    "full rewrites",
                    `${formatCompactNumber(hour.fullRewrites)} of ${formatCompactNumber(hour.calls)}`,
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
      {data.every((hour) => hour.calls === 0) ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
          No agent model calls in this period.
        </div>
      ) : null}
    </div>
  );
}

function Outcomes(props: { report: Report }) {
  const { warmups, breakerOpened, breakerClosed } = props.report.totals;
  const groups = [
    { label: "Sent after", counts: warmups.sentByTurnEnding },
    { label: "Skipped", counts: warmups.skipReasons },
    {
      label: "Breaker",
      counts: { opened: breakerOpened, "closed by an admin": breakerClosed },
    },
  ];
  return (
    <div className="grid gap-4 border-t border-dashboard-border-subtle px-4 py-4 sm:grid-cols-3 sm:px-5">
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
  const rows = Object.entries(props.counts).sort(
    ([, left], [, right]) => right - left,
  );
  return (
    <div className="min-w-0">
      <div className="font-sans text-xs font-medium text-dashboard-text-muted">
        {props.label}
      </div>
      {rows.length ? (
        <dl className="m-0 mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-sans text-xs">
          {rows.map(([key, count]) => (
            <div className="contents" key={key}>
              <dt className="min-w-0 truncate text-dashboard-text first-letter:uppercase">
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
