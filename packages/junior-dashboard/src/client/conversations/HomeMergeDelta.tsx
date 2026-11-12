import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "../styles";

/**
 * Show how a merge count changed against an earlier period: a small chip with
 * the direction and size of the change, then the period, as in "↑2 vs last
 * Wed". A rise is green. A fall stays neutral, because fewer merges is not an
 * error.
 */
export function HomeMergeDelta(props: {
  current: number;
  period: string;
  previous: number;
}) {
  const delta = props.current - props.previous;
  if (delta === 0) return <>same as {props.period}</>;
  const Arrow = delta > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 self-center rounded px-1 font-medium tabular-nums",
          delta > 0
            ? "bg-emerald-300/10 text-emerald-300"
            : "bg-dashboard-fill-strong text-dashboard-text",
        )}
      >
        <Arrow aria-hidden="true" className="size-3" strokeWidth={2.5} />
        <span className="sr-only">{delta > 0 ? "up" : "down"}</span>
        {Math.abs(delta)}
      </span>
      vs {props.period}
    </span>
  );
}
