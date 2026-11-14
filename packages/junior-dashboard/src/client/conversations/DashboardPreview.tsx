import type { ObjectFacts } from "@sentry/junior-plugin-api";
import { Sparkline } from "../components/charts/Sparkline";

type DashboardFacts = Extract<ObjectFacts, { type: "dashboard" }>;

/**
 * Show a dashboard's small charts side by side, then its first widgets by
 * title and display.
 */
export function DashboardPreview({ facts }: { facts: DashboardFacts }) {
  return (
    <>
      {facts.charts.length > 0 && (
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4">
          {facts.charts.map((chart, index) => (
            <Sparkline
              display={chart.display}
              key={index}
              label={chart.title}
              series={chart.series}
            />
          ))}
        </div>
      )}
      {facts.widgets.length > 0 && (
        <ul
          aria-label="Widgets"
          className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-4 gap-y-1 p-0 text-sm"
        >
          {facts.widgets.map((widget, index) => (
            <li className="flex min-w-0 items-baseline gap-2" key={index}>
              <span className="truncate text-dashboard-text">
                {widget.title}
              </span>
              <span className="shrink-0 text-xs text-dashboard-text-muted">
                {widget.display}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
