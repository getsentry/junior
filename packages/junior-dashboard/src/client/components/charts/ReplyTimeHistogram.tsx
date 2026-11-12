import type { ReplyTimeHistogram as ReplyTimeHistogramReport } from "@sentry/junior/api/schema";

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

const chartConfig = {
  share: { color: "var(--color-cyan-400)", label: "Replies" },
};

type Bin = ReplyTimeHistogramReport["bins"][number];

function binLabel(bin: Bin): string {
  return `${formatDuration(bin.startMs) || "0s"} to ${formatDuration(bin.endMs)}`;
}

function formatShare(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Summarize reply times for chart headers: the reply count, the bin of the
 * median reply, and the share of idle periods with no reply in the horizon.
 */
export function replyTimeSummary(histogram: ReplyTimeHistogramReport) {
  const replies = histogram.total - histogram.noReply;
  let seen = 0;
  const median = histogram.bins.find((bin) => {
    seen += bin.count;
    return seen * 2 >= replies;
  });
  return {
    median: replies && median ? binLabel(median) : undefined,
    noReplyShare: histogram.total
      ? formatShare((histogram.noReply / histogram.total) * 100)
      : undefined,
    replies,
  };
}

/**
 * Show how replies spread over the bins of the cache warming model, as a
 * share of all replies. Idle periods with no reply are left out, because
 * they would dwarf every bin.
 */
export function ReplyTimeHistogram(props: {
  className?: string;
  histogram: ReplyTimeHistogramReport;
}) {
  const replies = props.histogram.total - props.histogram.noReply;
  const data = props.histogram.bins.map((bin) => ({
    count: bin.count,
    // Bin ends are unique, so they name the bars.
    id: String(bin.endMs),
    label: binLabel(bin),
    share: replies ? (bin.count / replies) * 100 : 0,
  }));
  const labels = new Map(data.map((datum) => [datum.id, datum.label]));
  const maximum = Math.max(1, ...data.map((datum) => datum.share));
  return (
    <ChartContainer
      className={cn("aspect-auto h-48 w-full", props.className)}
      config={chartConfig}
    >
      <BarChart
        aria-label={`Reply times of ${replies} replies`}
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
          formatLabel={(id) => formatDuration(Number(id))}
          keys={data.map((datum) => datum.id)}
        />
        <ChartTooltip
          content={
            <ActivityChartTooltipContent
              formatLabel={(id) => labels.get(id) ?? id}
              rows={(datum: (typeof data)[number]) => [
                ["Replies", datum.count],
                ["Share", formatShare(datum.share)],
              ]}
            />
          }
        />
        <Bar
          dataKey="share"
          fill="var(--color-share)"
          fillOpacity={0.85}
          isAnimationActive={false}
          maxBarSize={32}
          radius={1.5}
        />
      </BarChart>
    </ChartContainer>
  );
}
