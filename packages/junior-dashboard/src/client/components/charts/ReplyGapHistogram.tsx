import type { ReplyGapHistogram as ReplyGapHistogramReport } from "@sentry/junior/api/schema";

import { Bar, BarChart, CartesianGrid } from "recharts";
import { cn } from "../../styles";
import { formatDuration } from "../Duration";
import { ChartContainer, ChartTooltip } from "../ui/chart";
import {
  activityChartMargin,
  ActivityChartTooltipContent,
  ActivityChartXAxis,
  ActivityChartYAxis,
} from "./ActivityChart";

const NO_REPLY_KEY = "no-reply";

const chartConfig = {
  noReply: { color: "var(--color-amber-400)", label: "No reply" },
  replies: { color: "var(--color-cyan-400)", label: "Replies" },
};

interface Datum {
  count: number;
  id: string;
  label: string;
  noReply: number;
  replies: number;
}

function share(count: number, total: number): number {
  return total ? (count / total) * 100 : 0;
}

function formatShare(value: number): string {
  return `${Math.round(value)}%`;
}

function chartData(histogram: ReplyGapHistogramReport): Datum[] {
  const { total } = histogram;
  return [
    ...histogram.bins.map((bin) => ({
      count: bin.count,
      // Bin ends are unique, so they name the bars.
      id: String(bin.endMs),
      label: `${formatDuration(bin.startMs) || "0s"} to ${formatDuration(bin.endMs)}`,
      noReply: 0,
      replies: share(bin.count, total),
    })),
    {
      count: histogram.noReply,
      id: NO_REPLY_KEY,
      label: "No reply",
      noReply: share(histogram.noReply, total),
      replies: 0,
    },
  ];
}

/**
 * Show reply gaps as a share of all gaps in the bins of the cache warming
 * model, with the idle periods that got no reply as the last bar.
 */
export function ReplyGapHistogram(props: {
  className?: string;
  histogram: ReplyGapHistogramReport;
}) {
  const data = chartData(props.histogram);
  const labels = new Map(data.map((datum) => [datum.id, datum.label]));
  const maximum = Math.max(
    1,
    ...data.map((datum) => datum.replies + datum.noReply),
  );
  return (
    <ChartContainer
      className={cn("aspect-auto h-48 w-full", props.className)}
      config={chartConfig}
    >
      <BarChart
        aria-label={`Reply gaps: ${props.histogram.total} gaps`}
        data={data}
        margin={activityChartMargin}
        role="img"
      >
        <CartesianGrid strokeDasharray="3 5" vertical={false} />
        <ActivityChartYAxis
          format={formatShare}
          maximum={Math.ceil(maximum / 10) * 10}
        />
        <ActivityChartXAxis
          centered
          dataKey="id"
          formatLabel={(id) =>
            id === NO_REPLY_KEY ? "No reply" : formatDuration(Number(id))
          }
          keys={data.map((datum) => datum.id)}
        />
        <ChartTooltip
          content={
            <ActivityChartTooltipContent
              formatLabel={(id) => labels.get(id) ?? id}
              rows={(datum: Datum) => [
                ["Gaps", datum.count],
                ["Share", formatShare(datum.replies + datum.noReply)],
              ]}
            />
          }
        />
        <Bar
          dataKey="replies"
          fill="var(--color-replies)"
          fillOpacity={0.85}
          isAnimationActive={false}
          maxBarSize={32}
          radius={1.5}
          stackId="gaps"
        />
        <Bar
          dataKey="noReply"
          fill="var(--color-noReply)"
          fillOpacity={0.85}
          isAnimationActive={false}
          maxBarSize={32}
          radius={1.5}
          stackId="gaps"
        />
      </BarChart>
    </ChartContainer>
  );
}
