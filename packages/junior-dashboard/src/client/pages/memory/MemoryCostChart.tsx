import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Bar, BarChart, CartesianGrid } from "recharts";
import {
  ActivityChartAverageLine,
  activityChartAverage,
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";

import { Card } from "../../components/layout/Card";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import { formatCostSummary } from "../../format";
import type { MemoryCostDay } from "./memoryDashboard";

const chartConfig = {
  extraction: { color: "var(--color-cyan-300)", label: "Extraction" },
  recall: { color: "var(--color-fuchsia-400)", label: "Recall" },
};

function formatCost(value: number): string {
  return formatCostSummary({ total: value });
}

/** Render stacked memory extraction and recall cost from durable plugin events. */
export function MemoryCostChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  extractionDays: MemoryCostDay[];
  range: TimeRangeDays;
  recallDays: MemoryCostDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const recallByDate = new Map(props.recallDays.map((day) => [day.date, day]));
  const days = props.extractionDays.map((extraction) => {
    const recall = recallByDate.get(extraction.date) ?? {
      costUsd: 0,
      date: extraction.date,
      events: 0,
    };
    return {
      date: extraction.date,
      extraction,
      extractionCost: extraction.costUsd,
      recall,
      recallCost: recall.costUsd,
    };
  });
  const extractionTotal = days.reduce(
    (sum, day) => sum + day.extraction.costUsd,
    0,
  );
  const recallTotal = days.reduce((sum, day) => sum + day.recall.costUsd, 0);
  const total = extractionTotal + recallTotal;
  const runs = days.reduce(
    (sum, day) => sum + day.extraction.events + day.recall.events,
    0,
  );
  const dayTotals = days.map(
    (day) => day.extraction.costUsd + day.recall.costUsd,
  );
  const maximum = Math.max(0.01, ...dayTotals);
  const average = activityChartAverage(dayTotals);

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {formatCostSummary({ total })}
        </h2>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          System-wide estimate across {formatRunCount(runs)} spanning extraction
          and recall.
        </p>
        <ChartLegend
          ariaLabel="Memory cost legend"
          items={[
            {
              color: "var(--color-cyan-300)",
              key: "extraction",
              label: "Extraction",
              value: formatCostSummary({ total: extractionTotal }),
            },
            {
              color: "var(--color-fuchsia-400)",
              key: "recall",
              label: "Recall",
              value: formatCostSummary({ total: recallTotal }),
            },
          ]}
        />
      </div>

      <div className="relative mt-4 overflow-hidden">
        <ChartContainer
          className="aspect-auto h-50 w-full"
          config={chartConfig}
        >
          <BarChart
            aria-label={`Memory extraction and recall cost during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
            data={days}
            margin={activityChartMargin}
            role="img"
          >
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <ActivityChartYAxis format={formatCost} maximum={maximum} />
            <ActivityChartXAxis keys={days.map((day) => day.date)} />
            <ChartTooltip
              content={
                <ActivityChartTooltipContent
                  rows={(day: (typeof days)[number]) => [
                    [
                      "extraction",
                      `${formatCost(day.extractionCost)} · ${formatRunCount(day.extraction.events)}`,
                    ],
                    [
                      "recall",
                      `${formatCost(day.recallCost)} · ${formatRunCount(day.recall.events)}`,
                    ],
                    ["total", formatCost(day.extractionCost + day.recallCost)],
                  ]}
                />
              }
            />
            <Bar
              dataKey="extractionCost"
              fill="var(--color-extraction)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
              stackId="cost"
            />
            <Bar
              dataKey="recallCost"
              fill="var(--color-recall)"
              fillOpacity={0.82}
              isAnimationActive={false}
              maxBarSize={13}
              stackId="cost"
            />
            <ActivityChartAverageLine
              unit={timeRangeBucketAverageUnit(bucketUnit)}
              average={average}
              format={formatCost}
              stroke="var(--color-slate-200)"
            />
          </BarChart>
        </ChartContainer>
        {runs === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-sans text-xs text-dashboard-text-muted">
            No memory extraction or recall ran in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function formatRunCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "run" : "runs"}`;
}
