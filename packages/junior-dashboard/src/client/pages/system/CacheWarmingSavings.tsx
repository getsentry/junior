import type { CacheWarmingSavingsReport } from "@sentry/junior/api/schema";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  YAxis,
} from "recharts";

import { useCacheWarmingHourly, useCacheWarmingSavings } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";
import { Card } from "../../components/layout/Card";
import { CacheWarmingRefill } from "./CacheWarmingRefill";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { StatTile } from "../../components/metrics/StatTile";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import {
  formatCompactNumber,
  formatCostBreakdown,
  formatCostSummary,
} from "../../format";

type Day = CacheWarmingSavingsReport["days"][number];
type Totals = CacheWarmingSavingsReport["totals"];
// A day or an hour. Hour keys are `YYYY-MM-DDTHH`.
type Bucket = Omit<Day, "unwarmedIdlePeriods" | "unwarmedOracleSavingsUsd">;

const GAIN_COLOR = "var(--color-emerald-400)";
const LOSS_COLOR = "var(--color-rose-400)";
const EFFECTIVENESS_COLOR = "var(--color-sky-400)";
// Days filled from history keep the bar color, lighter.
const LIVE_OPACITY = 0.82;
const HISTORY_OPACITY = 0.3;
const chartConfig = {
  netSavingsUsd: { color: GAIN_COLOR, label: "Net savings" },
  effectiveness: { color: EFFECTIVENESS_COLOR, label: "Effectiveness" },
};
const legendOf = (adjective: string) => [
  {
    color: GAIN_COLOR,
    key: "netSavingsUsd",
    label: `${adjective} net savings`,
  },
  {
    color: EFFECTIVENESS_COLOR,
    key: "effectiveness",
    label: `${adjective} effectiveness`,
  },
];
const historyLegend = {
  color: `color-mix(in oklab, ${GAIN_COLOR} ${HISTORY_OPACITY * 100}%, transparent)`,
  key: "history",
  label: "From history",
};

const usd = (value: number) => formatCostBreakdown({ total: value });
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Hours of the hourly report for a range. Longer ranges plot days. */
export function cacheWarmingHours(range: TimeRangeDays): number {
  return range === 1 ? 24 : 7 * 24;
}

/**
 * Show what cache warming saved in the range: net savings, effectiveness
 * against an ideal warmer, and net savings per UTC hour (24h and 7d) or day.
 * An admin can re-fill the days before live recording from history. Days
 * from history show as lighter bars.
 */
export function CacheWarmingSavings(props: {
  admin: boolean;
  range: TimeRangeDays;
}) {
  const daily = useCacheWarmingSavings(props.range);
  const hourly = useCacheWarmingHourly(cacheWarmingHours(props.range));
  const unit = props.range <= 7 ? "hour" : "day";
  const query = unit === "hour" ? hourly : daily;
  const data =
    unit === "hour"
      ? hourly.data && {
          buckets: hourly.data.hours.map((hour) => ({
            ...hour.savings,
            date: hour.hour.slice(0, 13),
            history: false,
          })),
          totals: {
            ...hourly.data.totals.savings,
            liveOracleSavingsUsd: hourly.data.totals.savings.oracleSavingsUsd,
            historyDays: 0,
          },
        }
      : daily.data && {
          buckets: daily.data.days,
          totals: daily.data.totals,
        };
  return (
    <section aria-label="Cache warming">
      <Card>
        <div className="border-b border-dashboard-border-subtle px-4 py-4 sm:px-5">
          <SectionTitle>Cache warming</SectionTitle>
          <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            Cache writes that warmups saved when a Conversation or a tool came
            back after the cache would have expired, less the cost of the
            warmups. Effectiveness is net savings as a share of what an ideal
            warmer would save.
          </p>
          {data ? <SavingsTotals totals={data.totals} /> : null}
          {props.admin ? <CacheWarmingRefill /> : null}
        </div>
        {data ? (
          <SavingsChart buckets={data.buckets} unit={unit} />
        ) : (
          <EmptyTelemetry>
            {query.error
              ? "Cache warming savings failed to load."
              : "Loading cache warming savings."}
          </EmptyTelemetry>
        )}
      </Card>
    </section>
  );
}

function SavingsTotals(props: { totals: Totals }) {
  const { totals } = props;
  const net = totals.netSavingsUsd;
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Net savings"
          value={usd(net)}
          valueClassName={net < 0 ? "text-rose-100" : "text-emerald-100"}
        />
        <StatTile
          label="Effectiveness"
          value={
            totals.effectiveness === null ? "—" : percent(totals.effectiveness)
          }
        />
        <StatTile
          label="Cache hits"
          value={`${formatCompactNumber(totals.hits)} of ${formatCompactNumber(totals.idlePeriods)}`}
        />
        <StatTile label="Warmup cost" value={usd(totals.warmupCostUsd)} />
      </div>
      {totals.historyDays > 0 ? (
        <p className="mt-3 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          Includes {totals.historyDays}{" "}
          {totals.historyDays === 1 ? "day" : "days"} from history, before live
          counters started. There, a hit counts only when a recorded warmup
          reached the return.
        </p>
      ) : null}
      {totals.unwarmedOracleSavingsUsd > 0 ? (
        <p className="mt-3 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {percent(
            totals.unwarmedOracleSavingsUsd / totals.liveOracleSavingsUsd,
          )}{" "}
          of possible savings{totals.historyDays > 0 ? " on live days" : ""} had
          no warm state.
        </p>
      ) : null}
    </>
  );
}

function SavingsChart(props: { buckets: Bucket[]; unit: "day" | "hour" }) {
  const data = props.buckets.map((bucket) => ({
    ...bucket,
    effectiveness: bucketEffectiveness(bucket),
  }));
  const legend = legendOf(props.unit === "hour" ? "Hourly" : "Daily");
  const shares = data.flatMap((day) =>
    day.effectiveness === null ? [] : [day.effectiveness],
  );
  const shareMaximum = Math.max(1, ...shares);
  const shareMinimum = Math.min(0, ...shares);
  const values = data.map((day) => day.netSavingsUsd);
  const maximum = Math.max(0.01, ...values);
  const minimum = Math.min(0, ...values);
  // Warmup cost lands when a warmup runs, before a call ends its idle period.
  const empty = props.buckets.every(
    (bucket) => bucket.idlePeriods === 0 && bucket.warmupCostUsd === 0,
  );
  return (
    <div className="relative px-2 py-3 sm:px-4 sm:py-4">
      <div className="px-2 pb-2">
        <ChartLegend
          ariaLabel="Cache warming chart legend"
          inline
          items={
            props.buckets.some((bucket) => bucket.history)
              ? [...legend, historyLegend]
              : legend
          }
        />
      </div>
      <ChartContainer className="aspect-auto h-50 w-full" config={chartConfig}>
        <ComposedChart
          aria-label={`Cache warming net savings and effectiveness per ${props.unit}`}
          data={data}
          margin={activityChartMargin}
          role="img"
        >
          <CartesianGrid strokeDasharray="3 5" vertical={false} />
          <ActivityChartYAxis
            format={(value) => formatCostSummary({ total: value })}
            maximum={maximum}
            minimum={minimum}
          />
          <YAxis
            axisLine={false}
            domain={[shareMinimum, shareMaximum]}
            interval={0}
            orientation="right"
            tickFormatter={percent}
            tickLine={false}
            tickMargin={8}
            ticks={[shareMinimum, shareMinimum < 0 ? 0 : 0.5, shareMaximum]}
            width="auto"
            yAxisId="effectiveness"
          />
          <ActivityChartXAxis keys={data.map((day) => day.date)} />
          <ChartTooltip
            content={
              <ActivityChartTooltipContent
                rows={(day: Bucket & { effectiveness: number | null }) => [
                  ...(day.history ? [["source", "history"] as const] : []),
                  ["net savings", usd(day.netSavingsUsd)],
                  [
                    "effectiveness",
                    day.effectiveness === null
                      ? "—"
                      : percent(day.effectiveness),
                  ],
                  ["saved writes", usd(day.savedUsd)],
                  ["warmup cost", usd(day.warmupCostUsd)],
                  [
                    "cache hits",
                    `${formatCompactNumber(day.hits)} of ${formatCompactNumber(day.idlePeriods)}`,
                  ],
                ]}
              />
            }
          />
          <ReferenceLine
            stroke="var(--color-dashboard-text-faint)"
            strokeOpacity={0.6}
            y={0}
          />
          <Bar
            dataKey="netSavingsUsd"
            isAnimationActive={false}
            maxBarSize={13}
            minPointSize={(value) => (value ? 2 : 0)}
            radius={2}
          >
            {data.map((day) => (
              <Cell
                fill={day.netSavingsUsd < 0 ? LOSS_COLOR : GAIN_COLOR}
                fillOpacity={day.history ? HISTORY_OPACITY : LIVE_OPACITY}
                key={day.date}
              />
            ))}
          </Bar>
          <Line
            connectNulls={false}
            dataKey="effectiveness"
            dot={{ fill: EFFECTIVENESS_COLOR, r: 2, strokeWidth: 0 }}
            isAnimationActive={false}
            stroke={EFFECTIVENESS_COLOR}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            type="linear"
            yAxisId="effectiveness"
          />
        </ComposedChart>
      </ChartContainer>
      {empty ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
          No idle periods or warmups in this period.
        </div>
      ) : null}
    </div>
  );
}

/** Net savings as a share of the oracle, or null without oracle savings. */
function bucketEffectiveness(bucket: Bucket): number | null {
  if (bucket.oracleSavingsUsd <= 0) return null;
  return bucket.netSavingsUsd / bucket.oracleSavingsUsd;
}
