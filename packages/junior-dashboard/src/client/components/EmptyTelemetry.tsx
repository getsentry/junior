import type { ReactNode } from "react";

/** Render the dashboard empty-state block with quiet warning context. */
export function EmptyTelemetry(props: { children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-dashboard-border-strong bg-dashboard-empty px-4 py-3 text-base leading-relaxed text-dashboard-text-muted">
      {props.children}
    </div>
  );
}
