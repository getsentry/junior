import type { PluginOperationalReport } from "@sentry/junior/api/schema";

import { cn } from "../../styles";

export type PluginReportRecordSetType = NonNullable<
  PluginOperationalReport["recordSets"]
>[number];

/** Render one operational-report record set for system or profile surfaces. */
export function PluginReportRecordSet(props: {
  /** Embedded rows sit inside a parent card; standalone owns its own surface. */
  embedded?: boolean;
  recordSet: PluginReportRecordSetType;
}) {
  const fields = props.recordSet.fields ?? [];
  const records = props.recordSet.records ?? [];
  const embedded = props.embedded === true;
  return (
    <div
      className={cn(
        embedded
          ? "border-t border-white/[0.06]"
          : "overflow-hidden rounded border border-white/[0.07] bg-dashboard-surface-panel",
      )}
    >
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
          <div className="grid gap-2 border-t border-white/[0.05] p-3 sm:hidden">
            {records.map((record) => (
              <div
                className={cn(
                  "grid gap-3 rounded-md border border-white/[0.06] bg-black/15 p-3",
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
          <div className="hidden overflow-x-auto border-t border-white/[0.05] sm:block">
            <table className="w-full min-w-[36rem] border-collapse text-left">
              <thead className="bg-black/15 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
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
                        className="max-w-72 truncate border-b border-white/[0.05] px-5 py-3 font-mono text-xs text-dashboard-text-muted"
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

function rowToneClass(tone: string | undefined): string {
  if (tone === "danger") return "bg-rose-500/[0.07]";
  if (tone === "warning") return "bg-amber-300/[0.045]";
  if (tone === "good") return "bg-emerald-400/[0.055]";
  return "";
}
