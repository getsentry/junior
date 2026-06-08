import { formatTime } from "../format";
import { cn } from "../styles";
import type { PluginReport } from "../types";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import { SectionTitle } from "./SectionTitle";

/** Render plugin operational reports without plugin-specific UI code. */
export function PluginReports(props: {
  emptyText?: string;
  reports: PluginReport[];
}) {
  if (props.reports.length === 0 && !props.emptyText) {
    return null;
  }

  if (props.reports.length === 0) {
    return (
      <Section>
        <SectionHeader>
          <SectionTitle>Plugin Reports</SectionTitle>
        </SectionHeader>
        <div className="px-4 py-4 text-[0.84rem] leading-relaxed text-[#888]">
          {props.emptyText}
        </div>
      </Section>
    );
  }

  return (
    <>
      {props.reports.map((report) => (
        <PluginReportView key={report.pluginName} report={report} />
      ))}
    </>
  );
}

function PluginReportView(props: { report: PluginReport }) {
  const title = props.report.title ?? props.report.pluginName;
  return (
    <Section>
      <SectionHeader
        actions={
          props.report.generatedAt ? (
            <div className="text-right text-[0.76rem] leading-tight text-[#888]">
              {formatTime(props.report.generatedAt)}
            </div>
          ) : null
        }
      >
        <SectionTitle>{title}</SectionTitle>
        <div className="mt-1 font-mono text-[0.72rem] leading-tight text-[#888]">
          {props.report.pluginName}
        </div>
      </SectionHeader>
      {props.report.metrics?.length ? (
        <div className="grid border-t border-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {props.report.metrics.map((metric) => (
            <div
              className={cn(
                "min-w-0 border-r border-t border-white/10 bg-[#050505] px-4 py-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 lg:border-t-0",
                summaryToneClass(metric.tone),
              )}
              key={metric.label}
            >
              <div className="truncate text-2xl font-extrabold leading-none text-white">
                {metric.value}
              </div>
              <div className="mt-1 text-[0.72rem] font-semibold uppercase leading-tight text-[#888]">
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
    </Section>
  );
}

type PluginReportRecordSetType = NonNullable<
  PluginReport["recordSets"]
>[number];

function PluginReportRecordSet(props: {
  recordSet: PluginReportRecordSetType;
}) {
  const fields = props.recordSet.fields ?? [];
  const records = props.recordSet.records ?? [];
  return (
    <div className="border-t border-white/10">
      <div className="px-4 py-2.5 text-[0.76rem] font-bold uppercase leading-none text-[#888]">
        {props.recordSet.title}
      </div>
      {records.length === 0 ? (
        <div className="px-4 pb-4 text-[0.84rem] leading-relaxed text-[#888]">
          {props.recordSet.emptyText ?? "No records."}
        </div>
      ) : fields.length === 0 ? (
        <div className="px-4 pb-4 text-[0.84rem] leading-relaxed text-[#888]">
          Report records are unavailable because no fields were declared.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-[0.82rem] leading-tight">
            <thead className="text-[0.7rem] uppercase text-[#888]">
              <tr>
                {fields.map((field) => (
                  <th
                    className="border-b border-white/10 px-4 py-2 font-semibold"
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
                <tr className={rowToneClass(record.tone)} key={record.id}>
                  {fields.map((field) => (
                    <td
                      className="max-w-72 truncate border-b border-white/10 px-4 py-2.5 text-[#d6d6d6]"
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
  if (tone === "danger") {
    return "bg-rose-500/10";
  }
  if (tone === "warning") {
    return "shadow-[inset_0_3px_0_rgba(250,204,21,0.85)]";
  }
  if (tone === "good") {
    return "bg-emerald-400/10";
  }
  return "";
}

function rowToneClass(tone: string | undefined): string {
  if (tone === "danger") {
    return "bg-rose-500/10";
  }
  if (tone === "warning") {
    return "bg-yellow-300/[0.06]";
  }
  if (tone === "good") {
    return "bg-emerald-400/10";
  }
  return "";
}
