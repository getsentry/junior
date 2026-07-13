import { RadioTower } from "lucide-react";
import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { formatTime } from "../format";
import { cn } from "../styles";
import { Card } from "./layout/Card";

/** Render plugin operational reports without plugin-specific UI code. */
export function PluginReports(props: {
  emptyText?: string;
  reports: PluginOperationalReport[];
}) {
  if (props.reports.length === 0 && !props.emptyText) return null;
  if (props.reports.length === 0) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.07] bg-white/[0.025] text-white/25">
            <RadioTower aria-hidden="true" size={17} />
          </div>
          <div>
            <h2 className="m-0 font-display text-base font-medium text-white/75">
              Operational reports
            </h2>
            <p className="mt-1 mb-0 font-mono text-[0.68rem] leading-relaxed text-white/30">
              {props.emptyText}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-end justify-between gap-4 px-1">
        <div>
          <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
            Live signals
          </div>
          <h2 className="mt-1 mb-0 font-display text-xl font-medium text-white">
            Operational reports
          </h2>
        </div>
        <div className="font-mono text-[0.62rem] text-white/30">
          {props.reports.length} reporting
        </div>
      </div>
      {props.reports.map((report) => (
        <PluginReportView key={report.pluginName} report={report} />
      ))}
    </div>
  );
}

function PluginReportView(props: { report: PluginOperationalReport }) {
  const title = props.report.title ?? props.report.pluginName;
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
        <div className="min-w-0">
          <h3 className="m-0 truncate font-display text-lg font-medium text-white">
            {title}
          </h3>
          <div className="mt-1 font-mono text-[0.62rem] text-white/30">
            {props.report.pluginName}
          </div>
        </div>
        {props.report.generatedAt ? (
          <div className="shrink-0 font-mono text-[0.62rem] text-white/30">
            updated {formatTime(props.report.generatedAt)}
          </div>
        ) : null}
      </div>
      {props.report.metrics?.length ? (
        <div className="grid gap-px bg-white/[0.055] sm:grid-cols-2 lg:grid-cols-4">
          {props.report.metrics.map((metric) => (
            <div
              className={cn(
                "min-w-0 bg-[#09090b] px-4 py-4",
                summaryToneClass(metric.tone),
              )}
              key={metric.label}
            >
              <div className="truncate font-display text-2xl font-light leading-none text-white">
                {metric.value}
              </div>
              <div className="mt-2 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-white/30">
                {metric.label}
              </div>
            </div>
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
    <div className="border-t border-white/[0.06]">
      <div className="flex items-center justify-between gap-4 px-5 py-3">
        <div className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-white/45">
          {props.recordSet.title}
        </div>
        <div className="font-mono text-[0.58rem] text-white/25">
          {records.length} records
        </div>
      </div>
      {records.length === 0 ? (
        <div className="px-5 pb-5 font-mono text-[0.68rem] leading-relaxed text-white/30">
          {props.recordSet.emptyText ?? "No records."}
        </div>
      ) : fields.length === 0 ? (
        <div className="px-5 pb-5 font-mono text-[0.68rem] leading-relaxed text-white/30">
          Report records are unavailable because no fields were declared.
        </div>
      ) : (
        <div className="overflow-x-auto border-t border-white/[0.05]">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead className="bg-black/15 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-white/25">
              <tr>
                {fields.map((field) => (
                  <th
                    className="border-b border-white/[0.055] px-5 py-2.5 font-medium"
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
                    "transition-colors hover:bg-white/[0.025]",
                    rowToneClass(record.tone),
                  )}
                  key={record.id}
                >
                  {fields.map((field) => (
                    <td
                      className="max-w-72 truncate border-b border-white/[0.05] px-5 py-3 font-mono text-[0.7rem] text-white/55"
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
