import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { cn } from "../../styles";
import { PluginBarChart } from "../system/PluginBarChart";
import { PluginReportRecordSet } from "../system/PluginReportRecordSet";

/**
 * Render person-scoped plugin reports as peer profile sections.
 *
 * Each report owns one section title. Do not wrap them in a parent section or
 * system-style ops card — that stacks badly once multiple plugins contribute.
 */
export function ProfilePluginReports(props: {
  range?: TimeRangeDays;
  reports: PluginOperationalReport[];
}) {
  if (props.reports.length === 0) return null;

  return (
    <>
      {props.reports.map((report) => (
        <ProfilePluginReport
          key={report.pluginName}
          range={props.range}
          report={report}
        />
      ))}
    </>
  );
}

function ProfilePluginReport(props: {
  range?: TimeRangeDays;
  report: PluginOperationalReport;
}) {
  const title =
    props.report.title && props.report.title !== props.report.pluginName
      ? props.report.title
      : props.report.pluginName;
  const metrics = props.report.metrics ?? [];
  const widgets = props.report.widgets ?? [];
  const recordSets = props.report.recordSets ?? [];
  if (!metrics.length && !widgets.length && !recordSets.length) return null;

  return (
    <section
      aria-labelledby={`profile-plugin-${props.report.pluginName}-title`}
      className="grid gap-4"
    >
      <SectionIntro
        id={`profile-plugin-${props.report.pluginName}-title`}
        title={title}
      />
      {metrics.length ? (
        <div
          className={cn(
            "grid gap-px overflow-hidden rounded border border-white/[0.07] bg-white/[0.055]",
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
                metricToneClass(metric.tone),
              )}
              key={metric.label}
            >
              <div className="truncate font-display text-2xl font-light leading-none text-dashboard-text">
                {metric.value}
              </div>
              <div className="mt-2 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
                {metric.label}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {widgets.length ? (
        <div
          className={cn(
            "grid gap-3",
            widgets.length > 1 ? "lg:grid-cols-2" : undefined,
          )}
        >
          {widgets.map((widget) => (
            <PluginBarChart
              key={widget.id}
              range={props.range}
              widget={widget}
            />
          ))}
        </div>
      ) : null}
      {recordSets.map((recordSet) => (
        <PluginReportRecordSet
          key={`${props.report.pluginName}:${recordSet.title}`}
          recordSet={recordSet}
        />
      ))}
    </section>
  );
}

function metricToneClass(
  tone: "danger" | "good" | "neutral" | "warning" | undefined,
): string | undefined {
  // Match system PluginReports: tone is an inset accent, not text color.
  // Child value/label classes own text color and would override parent text-*.
  if (tone === "danger") return "shadow-[inset_0_2px_0_rgba(251,113,133,0.65)]";
  if (tone === "warning") return "shadow-[inset_0_2px_0_rgba(251,191,36,0.65)]";
  if (tone === "good") return "shadow-[inset_0_2px_0_rgba(110,231,183,0.55)]";
  return undefined;
}
