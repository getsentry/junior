import { formatDuration } from "@sentry/junior-plugin-api";
import { cn } from "../../styles";
import { statusDotToneClass } from "../StatusDot";

type WaterfallSpan = {
  durationMs: number;
  issue?: boolean;
  name: string;
  op?: string;
  startMs: number;
};

// A span shorter than this share of the trace still shows as a mark.
const MIN_BAR_PERCENT = 0.75;

/**
 * Draw spans as rows of bars on one time axis that spans the whole trace,
 * so their order and overlap show at a glance. A span with an issue is red.
 */
export function TraceWaterfall({
  durationMs,
  label,
  spans,
}: {
  durationMs: number;
  label: string;
  spans: readonly WaterfallSpan[];
}) {
  const total = Math.max(
    durationMs,
    ...spans.map((span) => span.startMs + span.durationMs),
    1,
  );
  const percent = (ms: number) => Math.min((ms / total) * 100, 100);
  return (
    <figure className="m-0 grid gap-1.5">
      <figcaption className="text-xs text-dashboard-text-muted">
        {label}
      </figcaption>
      <ol className="m-0 grid list-none gap-1 p-0">
        {spans.map((span, index) => {
          const left = percent(span.startMs);
          const width = Math.max(percent(span.durationMs), MIN_BAR_PERCENT);
          return (
            <li
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem] items-center gap-2 text-xs"
              key={index}
            >
              <span className="truncate text-dashboard-text">
                {span.op && (
                  <span className="text-dashboard-text-muted">{span.op} </span>
                )}
                {span.name}
              </span>
              <span
                aria-hidden="true"
                className="relative h-2 rounded-sm bg-dashboard-surface-hover"
              >
                <span
                  className={cn(
                    "absolute inset-y-0 rounded-sm",
                    statusDotToneClass[span.issue ? "danger" : "accent"],
                  )}
                  style={{
                    left: `${Math.min(left, 100 - width)}%`,
                    width: `${width}%`,
                  }}
                />
              </span>
              <span className="text-right tabular-nums text-dashboard-text-muted">
                {formatDuration(span.durationMs)}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
