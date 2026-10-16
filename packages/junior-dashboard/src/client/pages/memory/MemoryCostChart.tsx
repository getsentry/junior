import {
  type TimeRangeBucketUnit,
  timeRangeBucketAverageUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import {
  activityChartAverage,
  ActivityTooltipRows,
  ChartBar,
  ChartBucket,
  ChartFrame,
  chartPercent,
} from "../../components/charts/ActivityChart";
import { ChartLegend } from "../../components/charts/ChartLegend";

import { Card } from "../../components/layout/Card";
import { formatCostSummary } from "../../format";
import type { MemoryCostDay } from "./memoryDashboard";

const EXTRACTION_COLOR = "#67e8f9";
const RECALL_COLOR = "#e879f9";

/** Render stacked memory extraction and recall cost from durable plugin events. */
export function MemoryCostChart(props: {
  bucketUnit?: TimeRangeBucketUnit;

  extractionDays: MemoryCostDay[];
  range: TimeRangeDays;
  recallDays: MemoryCostDay[];
}) {
  const bucketUnit = props.bucketUnit ?? "day";

  const recallByDate = new Map(props.recallDays.map((day) => [day.date, day]));
  const days = props.extractionDays.map((extraction) => ({
    date: extraction.date,
    extraction,
    recall: recallByDate.get(extraction.date) ?? {
      costUsd: 0,
      date: extraction.date,
      events: 0,
    },
  }));
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
  const formatCost = (value: number) => formatCostSummary({ total: value });

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
              color: EXTRACTION_COLOR,
              key: "extraction",
              label: "Extraction",
              value: formatCostSummary({ total: extractionTotal }),
            },
            {
              color: RECALL_COLOR,
              key: "recall",
              label: "Recall",
              value: formatCostSummary({ total: recallTotal }),
            },
          ]}
        />
      </div>

      <div className="mt-4">
        <ChartFrame
          aria-label={`Memory extraction and recall cost during the last ${props.range === 1 ? "24 hours" : `${props.range} days`}`}
          average={{
            color: "#e2e8f0",
            format: formatCost,
            unit: timeRangeBucketAverageUnit(bucketUnit),
            value: average,
          }}
          buckets={days.map((day) => day.date)}
          empty={
            runs === 0
              ? "No memory extraction or recall ran in this period."
              : undefined
          }
          formatTick={formatCost}
          maximum={maximum}
        >
          {days.map((day) => {
            const dayTotal = day.extraction.costUsd + day.recall.costUsd;
            return (
              <ChartBucket
                bucket={day.date}
                content={
                  <ActivityTooltipRows
                    rows={[
                      [
                        "extraction",
                        `${formatCost(day.extraction.costUsd)} · ${formatRunCount(day.extraction.events)}`,
                      ],
                      [
                        "recall",
                        `${formatCost(day.recall.costUsd)} · ${formatRunCount(day.recall.events)}`,
                      ],
                      ["total", formatCost(dayTotal)],
                    ]}
                  />
                }
                key={day.date}
                summary={`extraction ${formatCost(day.extraction.costUsd)}, ${formatRunCount(day.extraction.events)}; recall ${formatCost(day.recall.costUsd)}, ${formatRunCount(day.recall.events)}`}
              >
                <span className="flex h-full w-[68%] max-w-3.25 flex-col-reverse">
                  <ChartBar
                    className="w-full opacity-82"
                    fill={EXTRACTION_COLOR}
                    percent={chartPercent(day.extraction.costUsd, maximum)}
                  />
                  <ChartBar
                    className="w-full opacity-82"
                    fill={RECALL_COLOR}
                    percent={chartPercent(day.recall.costUsd, maximum)}
                  />
                </span>
              </ChartBucket>
            );
          })}
        </ChartFrame>
      </div>
    </Card>
  );
}

function formatRunCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "run" : "runs"}`;
}
