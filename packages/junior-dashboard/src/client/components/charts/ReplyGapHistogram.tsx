import type { ReplyGapHistogram as ReplyGapHistogramReport } from "@sentry/junior/api/schema";

import { cn } from "../../styles";
import { formatDuration } from "../Duration";

interface Bar {
  count: number;
  label: string;
  noReply: boolean;
}

function bars(histogram: ReplyGapHistogramReport): Bar[] {
  return [
    ...histogram.bins.map((bin) => ({
      count: bin.count,
      label: `${formatDuration(bin.startMs) || "0s"} to ${formatDuration(bin.endMs)}`,
      noReply: false,
    })),
    { count: histogram.noReply, label: "No reply", noReply: true },
  ];
}

function share(count: number, total: number): string {
  return total ? `${Math.round((count / total) * 100)}%` : "0%";
}

/**
 * Show reply gaps in the bins of the cache warming model, with the idle
 * periods that got no reply as the last bar.
 */
export function ReplyGapHistogram(props: {
  className?: string;
  histogram: ReplyGapHistogramReport;
}) {
  const items = bars(props.histogram);
  const maximum = Math.max(1, ...items.map((item) => item.count));
  const last = props.histogram.bins.at(-1);
  return (
    <div className={cn("grid grid-rows-[1fr_auto] gap-1.5", props.className)}>
      <div
        aria-label={`${props.histogram.total} gaps: ${items
          .filter((item) => item.count > 0)
          .map(
            (item) =>
              `${item.label}, ${share(item.count, props.histogram.total)}`,
          )
          .join("; ")}`}
        className="flex h-full min-h-0 items-end gap-px border-b border-dashboard-border-subtle"
        role="img"
      >
        {items.map((item) => (
          <div
            className={cn(
              "min-w-0 rounded-t-[1px]",
              item.noReply
                ? "ml-1 flex-[3] bg-amber-300/55"
                : "flex-1 bg-cyan-300/70",
              item.count === 0 && "bg-transparent",
            )}
            key={item.label}
            style={{ height: `${(item.count / maximum) * 100}%` }}
            title={`${item.label}: ${item.count} (${share(item.count, props.histogram.total)})`}
          />
        ))}
      </div>
      <div className="flex gap-px font-mono text-2xs text-dashboard-text-muted">
        <div
          className="flex justify-between"
          style={{ flex: props.histogram.bins.length }}
        >
          <span>0s</span>
          <span>{last ? formatDuration(last.endMs) : ""}</span>
        </div>
        <span className="ml-1 flex-[3] truncate text-right">No reply</span>
      </div>
    </div>
  );
}
