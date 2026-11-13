import type { CacheWarmingSavingsReport } from "@sentry/junior/api/schema";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine } from "recharts";

import { useCacheWarmingSavings } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { Card } from "../../components/layout/Card";
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

const GAIN_COLOR = "var(--color-emerald-400)";
const LOSS_COLOR = "var(--color-rose-400)";
const chartConfig = {
  netSavingsUsd: { color: GAIN_COLOR, label: "Net savings" },
};

const usd = (value: number) => formatCostBreakdown({ total: value });
const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Show what cache warming saved in the range: net savings, effectiveness
 * against an ideal warmer, and net savings per UTC day.
 */
export function CacheWarmingSavings(props: { range: TimeRangeDays }) {
  const query = useCacheWarmingSavings(props.range);
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
          {query.data ? <Totals totals={query.data.totals} /> : null}
        </div>
        {query.data ? (
          <SavingsChart days={query.data.days} />
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

function Totals(props: { totals: CacheWarmingSavingsReport["totals"] }) {
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
      {totals.unwarmedOracleSavingsUsd > 0 ? (
        <p className="mt-3 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          {percent(totals.unwarmedOracleSavingsUsd / totals.oracleSavingsUsd)}{" "}
          of possible savings had no warm state.
        </p>
      ) : null}
    </>
  );
}

function SavingsChart(props: { days: Day[] }) {
  const data = props.days;
  const values = props.days.map((day) => day.netSavingsUsd);
  const maximum = Math.max(0.01, ...values);
  const minimum = Math.min(0, ...values);
  // Warmup cost lands when a warmup runs, before a call ends its idle period.
  const empty = props.days.every(
    (day) => day.idlePeriods === 0 && day.warmupCostUsd === 0,
  );
  return (
    <div className="relative px-2 py-3 sm:px-4 sm:py-4">
      <ChartContainer className="aspect-auto h-50 w-full" config={chartConfig}>
        <BarChart
          aria-label="Cache warming net savings per day"
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
          <ActivityChartXAxis keys={data.map((day) => day.date)} />
          <ChartTooltip
            content={
              <ActivityChartTooltipContent
                rows={(day: Day) => [
                  ["net savings", usd(day.netSavingsUsd)],
                  [
                    "effectiveness",
                    day.oracleSavingsUsd > 0
                      ? percent(day.netSavingsUsd / day.oracleSavingsUsd)
                      : "—",
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
            fillOpacity={0.82}
            isAnimationActive={false}
            maxBarSize={13}
            minPointSize={(value) => (value ? 2 : 0)}
            radius={2}
          >
            {data.map((day) => (
              <Cell
                fill={day.netSavingsUsd < 0 ? LOSS_COLOR : GAIN_COLOR}
                key={day.date}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      {empty ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
          No idle periods or warmups in this period.
        </div>
      ) : null}
    </div>
  );
}
