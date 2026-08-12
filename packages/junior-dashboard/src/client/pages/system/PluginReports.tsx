import { RadioTower } from "lucide-react";
import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { formatTime } from "../../format";
import { cn } from "../../styles";
import { PluginBarChart } from "./PluginBarChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";

/** Render plugin operational reports without plugin-specific UI code. */
export function PluginReports(props: {
  emptyText?: string;
  fallbackTitle?: string;
  range?: TimeRangeDays;
  reports: PluginOperationalReport[];
}) {
  if (props.reports.length === 0 && !props.emptyText) return null;
  if (props.reports.length === 0) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded border border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted">
            <RadioTower aria-hidden="true" size={17} />
          </div>
          <div>
            <h2 className="m-0 font-display text-base font-medium text-dashboard-text-muted">
              Operational reports
            </h2>
            <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
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
        className="px-1"
        title="Operational reports"
      />
      {props.reports.map((report) => (
        <PluginReportView
          fallbackTitle={props.fallbackTitle}
          key={report.pluginName}
          range={props.range}
          report={report}
        />
      ))}
    </div>
  );
}

function PluginReportView(props: {
  fallbackTitle?: string;
  range?: TimeRangeDays;
  report: PluginOperationalReport;
}) {
  const reportTitle =
    props.report.title === props.report.pluginName
      ? undefined
      : props.report.title;
  const title = reportTitle ?? props.fallbackTitle ?? props.report.pluginName;
  const metrics = props.report.metrics ?? [];
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-dashboard-border-subtle px-5 py-4">
        <div className="min-w-0">
          <h3 className="m-0 truncate font-display text-lg font-medium text-dashboard-text">
            {title}
          </h3>
          <div className="mt-1 hidden font-mono text-xs text-dashboard-text-muted sm:block">
            {props.report.pluginName}
          </div>
        </div>
        {props.report.generatedAt ? (
          <div className="hidden shrink-0 font-mono text-xs text-dashboard-text-muted sm:block">
            updated {formatTime(props.report.generatedAt)}
          </div>
        ) : null}
      </div>
      {metrics.length ? (
        <div
          className={cn(
            "grid gap-px bg-dashboard-fill-mid",
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
              <div className="mt-2 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
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
          key={`${props.report.pluginName}:${recordSet.title}`}
          recordSet={recordSet}
        />
      ))}
    </Card>
  );
}

type PluginReportRecordSetType = NonNullable<
  PluginOperationalReport["recordSets"]
>[number];

function PluginReportRecordSet(props: {
  recordSet: PluginReportRecordSetType;
}) {
  const fields = props.recordSet.fields ?? [];
  const records = props.recordSet.records ?? [];
  return (
    <div className="border-t border-dashboard-border-subtle">
      <div className="flex items-center justify-between gap-4 px-5 py-3">
        <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
          {props.recordSet.title}
        </div>
        <div className="hidden font-mono text-xs text-dashboard-text-muted sm:block">
          {records.length} records
        </div>
      </div>
      {records.length === 0 ? (
        <div className="px-5 pb-5 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          {props.recordSet.emptyText ?? "No records."}
        </div>
      ) : fields.length === 0 ? (
        <div className="px-5 pb-5 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          Report records are unavailable because no fields were declared.
        </div>
      ) : (
        <>
          <div className="grid gap-2 border-t border-dashboard-border-faint p-3 sm:hidden">
            {records.map((record) => (
              <div
                className={cn(
                  "grid gap-3 rounded-md border border-dashboard-border-subtle bg-dashboard-overlay-soft p-3",
                  rowToneClass(record.tone),
                )}
                key={record.id}
              >
                {fields.map((field) => (
                  <div key={field.key}>
                    <div className="font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
                      {field.label}
                    </div>
                    <div className="mt-1 break-words font-mono text-xs leading-relaxed text-dashboard-text-muted">
                      {record.values[field.key] ?? ""}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto border-t border-dashboard-border-faint sm:block">
            <table className="w-full min-w-[36rem] border-collapse text-left">
              <thead className="bg-dashboard-overlay-soft font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
                <tr>
                  {fields.map((field) => (
                    <th
                      className="border-b border-dashboard-border-subtle px-5 py-2.5 font-medium"
                      key={field.key}
                      scope="col"
                    >
                      {field.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr
                    className={cn(
                      "transition-colors hover:bg-dashboard-fill-soft",
                      rowToneClass(record.tone),
                    )}
                    key={record.id}
                  >
                    {fields.map((field) => (
                      <td
                        className="max-w-72 truncate border-b border-dashboard-border-faint px-5 py-3 font-mono text-xs text-dashboard-text-muted"
                        key={field.key}
                      >
                        {record.values[field.key] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function summaryToneClass(tone: string | undefined): string {
  if (tone === "danger") return "shadow-[inset_0_2px_0_rgba(251,113,133,0.65)]";
  if (tone === "warning") return "shadow-[inset_0_2px_0_rgba(251,191,36,0.65)]";
  if (tone === "good") return "shadow-[inset_0_2px_0_rgba(110,231,183,0.55)]";
  return "";
}

function rowToneClass(tone: string | undefined): string {
  if (tone === "danger") return "bg-rose-500/[0.07]";
  if (tone === "warning") return "bg-amber-300/[0.045]";
  if (tone === "good") return "bg-emerald-400/[0.055]";
  return "";
}
