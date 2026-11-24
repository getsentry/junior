import type { PersonSpendDay } from "@sentry/junior/api/schema";
import { Area, Bar, CartesianGrid, ComposedChart, Line, YAxis } from "recharts";

import { ChartHeader } from "../../components/charts/ChartHeader";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatCompactNumber, formatCostSummary } from "../../format";

// One person runs few Turns in an hour, so a per-person ratio below a day is
// mostly noise. The 24h range shows the last week of days instead.
const MIN_DAYS = 7;

const PER_PERSON = {
  mean: { color: "var(--color-amber-400)", label: "Mean per person" },
  people: { color: "var(--color-cyan-400)", label: "Active people" },
} as const;

const BY_ACTOR = {
  people: { color: "var(--color-amber-400)", label: "People" },
  unattributed: { color: "var(--color-slate-400)", label: "Overhead" },
} as const;

type Point = PersonSpendDay & { mean: number | null };

function formatCost(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : formatCostSummary({ total: value }) || "$0.00";
}

function formatAxisCost(value: number): string {
  return value < 100
    ? formatCostSummary({ total: value }) || "$0"
    : `$${formatCompactNumber(value)}`;
}

/**
 * Plot daily spend per active person next to the daily split of spend
 * between people and overhead, which is Turns with no verified person.
 * People spend is active people times the mean, so the two charts show
 * whether spend grows with people, with use per person, or with overhead.
 */
export function PersonSpendCharts(props: {
  days: readonly PersonSpendDay[];
  range: TimeRangeDays;
}) {
  const data: Point[] = props.days
    .slice(-Math.max(props.range, MIN_DAYS))
    .map((day) => ({
      ...day,
      mean: day.people ? day.personCostUsd / day.people : null,
    }));
  const keys = data.map((day) => day.date);
  const totals = data.reduce(
    (total, day) => ({
      personCostUsd: total.personCostUsd + day.personCostUsd,
      personDays: total.personDays + day.people,
      unattributedCostUsd: total.unattributedCostUsd + day.unattributedCostUsd,
    }),
    { personCostUsd: 0, personDays: 0, unattributedCostUsd: 0 },
  );
  const periodMean = totals.personDays
    ? totals.personCostUsd / totals.personDays
    : null;
  const meanMaximum = Math.max(
    Number.EPSILON,
    ...data.map((day) => day.mean ?? 0),
  );
  const peopleMaximum = Math.max(1, ...data.map((day) => day.people));
  const spendMaximum = Math.max(
    Number.EPSILON,
    ...data.map((day) => day.personCostUsd + day.unattributedCostUsd),
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <ChartHeader
          description="Daily spend of verified people over the people active that day."
          title="Spend per person"
          trailing={
            <ChartLegend
              ariaLabel="Spend per person series"
              inline
              items={[
                {
                  ...PER_PERSON.mean,
                  key: "mean",
                  value: `${formatCost(periodMean)} / day`,
                },
                { ...PER_PERSON.people, key: "people" },
              ]}
            />
          }
        />
        <div className="px-2 py-2">
          <ChartContainer
            className="aspect-auto h-38 w-full"
            config={PER_PERSON}
          >
            <ComposedChart
              aria-label="Daily mean spend per active person"
              data={data}
              margin={activityChartMargin}
              role="img"
            >
              <CartesianGrid strokeDasharray="3 5" vertical={false} />
              <ActivityChartYAxis
                format={formatAxisCost}
                maximum={meanMaximum}
              />
              {/* Bars show the head count on their own hidden scale. */}
              <YAxis domain={[0, peopleMaximum]} hide yAxisId="people" />
              <ActivityChartXAxis keys={keys} />
              <ChartTooltip
                content={
                  <ActivityChartTooltipContent
                    rows={(day: Point) => [
                      ["Mean per person", formatCost(day.mean)],
                      [
                        "Median per person",
                        formatCost(day.medianPersonCostUsd),
                      ],
                      ["Active people", formatCompactNumber(day.people)],
                    ]}
                  />
                }
              />
              <Bar
                dataKey="people"
                fill="var(--color-people)"
                fillOpacity={0.25}
                isAnimationActive={false}
                maxBarSize={8}
                radius={1.5}
                yAxisId="people"
              />
              <Line
                connectNulls
                dataKey="mean"
                dot={false}
                isAnimationActive={false}
                stroke="var(--color-mean)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                type="linear"
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      </Card>
      <Card>
        <ChartHeader
          description="Overhead is spend with no verified person, such as Automation runs."
          title="Spend by Actor"
          trailing={
            <ChartLegend
              ariaLabel="Spend by Actor series"
              inline
              items={[
                {
                  ...BY_ACTOR.people,
                  key: "people",
                  value: formatCost(totals.personCostUsd),
                },
                {
                  ...BY_ACTOR.unattributed,
                  key: "unattributed",
                  value: formatCost(totals.unattributedCostUsd),
                },
              ]}
            />
          }
        />
        <div className="px-2 py-2">
          <ChartContainer className="aspect-auto h-38 w-full" config={BY_ACTOR}>
            <ComposedChart
              aria-label="Daily model spend by Actor"
              data={data}
              margin={activityChartMargin}
              role="img"
            >
              <CartesianGrid strokeDasharray="3 5" vertical={false} />
              <ActivityChartYAxis
                format={formatAxisCost}
                maximum={spendMaximum}
              />
              <ActivityChartXAxis keys={keys} />
              <ChartTooltip
                content={
                  <ActivityChartTooltipContent
                    rows={(day: Point) => [
                      ["People", formatCost(day.personCostUsd)],
                      ["Overhead", formatCost(day.unattributedCostUsd)],
                    ]}
                  />
                }
              />
              <Area
                dataKey="personCostUsd"
                fill="var(--color-people)"
                fillOpacity={0.2}
                isAnimationActive={false}
                stackId="spend"
                stroke="var(--color-people)"
                strokeWidth={1.5}
                type="linear"
              />
              <Area
                dataKey="unattributedCostUsd"
                fill="var(--color-unattributed)"
                fillOpacity={0.2}
                isAnimationActive={false}
                stackId="spend"
                stroke="var(--color-unattributed)"
                strokeWidth={1.5}
                type="linear"
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      </Card>
    </div>
  );
}
