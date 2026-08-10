import type { ReactNode } from "react";

import { cn } from "../../styles";

/** Shared title style for chart headers and period-total values. */
export const chartHeaderPrimaryClassName =
  "m-0 font-mono text-sm font-medium text-dashboard-text";

/** Shared supporting copy style for chart descriptions and total captions. */
export const chartHeaderSecondaryClassName =
  "mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted";

/**
 * Card header used by metric charts.
 * Title and period-total value always share the same primary type style.
 */
export function ChartHeader(props: {
  className?: string;
  description?: ReactNode;
  title: ReactNode;
  total?: ReactNode;
  totalLabel?: ReactNode;
  trailing?: ReactNode;
}) {
  const totalLabel = props.totalLabel ?? "period total";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-4 sm:px-5",
        props.className,
      )}
    >
      <div className="min-w-0">
        <h3 className={chartHeaderPrimaryClassName}>{props.title}</h3>
        {props.description ? (
          <p className={chartHeaderSecondaryClassName}>{props.description}</p>
        ) : null}
      </div>
      {props.total !== undefined ? (
        <div className="shrink-0 text-right">
          <div className={chartHeaderPrimaryClassName}>{props.total}</div>
          <div className={chartHeaderSecondaryClassName}>{totalLabel}</div>
        </div>
      ) : props.trailing ? (
        <div className="font-mono text-xs text-dashboard-text-muted">
          {props.trailing}
        </div>
      ) : null}
    </div>
  );
}
