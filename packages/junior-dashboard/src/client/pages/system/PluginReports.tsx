import { RadioTower } from "lucide-react";
import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { formatTime } from "../../format";
import { cn } from "../../styles";
import { PluginBarChart } from "./PluginBarChart";
import { PluginReportRecordSet } from "./PluginReportRecordSet";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";

/** Render plugin operational reports without plugin-specific UI code. */
export function PluginReports(props: {
  emptyText?: string;
  range?: TimeRangeDays;
  reports: PluginOperationalReport[];
}) {
  if (props.reports.length === 0 && !props.emptyText) return null;
  if (props.reports.length === 0) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-md border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted">
            <RadioTower aria-hidden="true" size={17} />
          </div>
          <div>
            <h2 className="m-0 font-display text-base font-medium text-dashboard-text-muted">
              Operational reports
            </h2>
            <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
              {props.emptyText}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      <SectionIntro
        anchor="reports"
        className="px-1"
        title="Operational reports"
      />
      {props.reports.map((report) => (
        <PluginReportView
          key={report.pluginName}
          range={props.range}
          report={report}
        />
      ))}
    </div>
  );
}

function PluginReportView(props: {
  range?: TimeRangeDays;
  report: PluginOperationalReport;
}) {
  // The page header already names the plugin and Details shows its
  // identifier, so the card shows only a report title of its own.
  const title =
    props.report.title === props.report.pluginName
      ? undefined
      : props.report.title;
  const metrics = props.report.metrics ?? [];
  return (
    <Card>
      {title || props.report.generatedAt ? (
        <div className="flex items-start justify-between gap-4 border-b border-dashboard-border-subtle px-5 py-4">
          {title ? (
            <h3 className="m-0 min-w-0 truncate font-display text-lg font-medium text-dashboard-text">
              {title}
            </h3>
          ) : null}
          {props.report.generatedAt ? (
            <div className="ml-auto shrink-0 font-mono text-xs text-dashboard-text-muted">
              updated {formatTime(props.report.generatedAt)}
            </div>
          ) : null}
        </div>
      ) : null}
      {metrics.length ? (
        <div
          className={cn(
            "grid gap-px bg-dashboard-fill-hover",
            metrics.length === 1 ? "grid-cols-1" : "grid-cols-2",
            metrics.length === 3
              ? "lg:grid-cols-3"
              : metrics.length === 5
                ? "lg:grid-cols-5"
                : metrics.length >= 4
                  ? "lg:grid-cols-4"
                  : undefined,
          )}
        >
          {metrics.map((metric) => (
            <div
              className={cn(
                "min-w-0 bg-dashboard-surface-panel px-4 py-4",
                metrics.length > 1 &&
                  metrics.length % 2 === 1 &&
                  "last:col-span-2 lg:last:col-span-1",
                summaryToneClass(metric.tone),
              )}
              key={metric.label}
            >
              <div className="truncate font-display text-2xl font-light leading-none text-dashboard-text">
                {metric.value}
              </div>
              <div className="mt-2 font-sans font-medium text-xs text-dashboard-text-muted">
                {metric.label}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {props.report.widgets?.length ? (
        <div className="grid gap-3 border-t border-dashboard-border-subtle bg-dashboard-overlay-soft p-3 lg:grid-cols-2">
          {props.report.widgets.map((widget) => (
            <PluginBarChart
              key={widget.id}
              range={props.range}
              widget={widget}
            />
          ))}
        </div>
      ) : null}
      {props.report.recordSets?.map((recordSet) => (
        <PluginReportRecordSet
          embedded
          key={`${props.report.pluginName}:${recordSet.title}`}
          recordSet={recordSet}
        />
      ))}
    </Card>
  );
}

function summaryToneClass(tone: string | undefined): string {
  if (tone === "danger") return "shadow-[inset_0_2px_0_rgba(251,113,133,0.65)]";
  if (tone === "warning") return "shadow-[inset_0_2px_0_rgba(251,191,36,0.65)]";
  if (tone === "good") return "shadow-[inset_0_2px_0_rgba(110,231,183,0.55)]";
  return "";
}
