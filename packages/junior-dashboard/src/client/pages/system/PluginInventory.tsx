import { Boxes, Radio } from "lucide-react";
import type {
  PluginOperationalReport,
  PluginReport,
} from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { formatCompactNumber } from "../../format";
import { cn } from "../../styles";

type PluginRow = {
  loaded: boolean;
  name: string;
  report?: PluginOperationalReport;
};

/** Present loaded plugins as an operational capability roster. */
export function PluginInventory(props: {
  loadingReports: boolean;
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
}) {
  const rows = buildPluginRows(props);
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4 max-sm:flex-col">
        <div>
          <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
            Capability map
          </div>
          <h2 className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-white">
            Plugins
          </h2>
          <p className="mt-1.5 mb-0 max-w-2xl font-mono text-[0.66rem] leading-relaxed text-white/30">
            What Junior loaded, what each plugin contributes, and which ones are
            reporting operational data.
          </p>
        </div>
        <div className="grid min-w-[18rem] grid-cols-3 overflow-hidden rounded-lg border border-white/[0.07] bg-black/15 max-sm:w-full max-sm:min-w-0">
          <InventoryMetric label="loaded" value={props.plugins.length} />
          <InventoryMetric
            label="reporting"
            value={props.loadingReports ? "…" : props.reports.length}
          />
          <InventoryMetric label="known" value={rows.length} />
        </div>
      </div>

      <div className="grid gap-2 p-3 sm:p-4">
        {rows.length ? (
          rows.map((row) => <PluginRosterRow key={row.name} row={row} />)
        ) : (
          <div className="rounded-lg border border-dashed border-white/[0.08] px-4 py-8 text-center font-mono text-[0.72rem] text-white/30">
            No plugin inventory has been reported yet.
          </div>
        )}
      </div>
    </Card>
  );
}

function PluginRosterRow(props: { row: PluginRow }) {
  const metricCount = props.row.report?.metrics?.length ?? 0;
  const recordSetCount = props.row.report?.recordSets?.length ?? 0;
  return (
    <article className="grid min-w-0 gap-3 rounded-lg border border-white/[0.065] bg-white/[0.025] px-4 py-2.5 transition-colors hover:border-white/[0.11] hover:bg-white/[0.035] md:grid-cols-[minmax(12rem,1fr)_auto] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-200">
          <Boxes aria-hidden="true" size={18} strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <div className="truncate font-display text-base font-medium text-white">
            {props.row.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusPill
              active={props.row.loaded}
              label={props.row.loaded ? "loaded" : "report only"}
            />
            <StatusPill
              active={Boolean(props.row.report)}
              label={props.row.report ? "reporting" : "quiet"}
            />
          </div>
        </div>
      </div>

      <div className="flex min-w-[10rem] items-center justify-between gap-5 rounded-lg border border-white/[0.055] bg-black/15 px-3 py-1.5 md:justify-end">
        <OperationalCount label="metrics" value={metricCount} />
        <OperationalCount label="datasets" value={recordSetCount} />
      </div>
    </article>
  );
}

function StatusPill(props: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[0.55rem] uppercase tracking-[0.08em]",
        props.active
          ? "border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100/65"
          : "border-white/[0.06] bg-white/[0.025] text-white/30",
      )}
    >
      <span
        className={cn(
          "size-1 rounded-full",
          props.active ? "bg-emerald-300" : "bg-white/20",
        )}
      />
      {props.label}
    </span>
  );
}

function InventoryMetric(props: { label: string; value: number | string }) {
  return (
    <div className="border-r border-white/[0.06] px-3 py-2.5 text-center last:border-r-0">
      <div className="font-display text-xl font-light leading-none text-white/90">
        {typeof props.value === "number"
          ? formatCompactNumber(props.value)
          : props.value}
      </div>
      <div className="mt-1.5 font-mono text-[0.52rem] uppercase tracking-[0.1em] text-white/25">
        {props.label}
      </div>
    </div>
  );
}

function OperationalCount(props: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="flex items-center justify-end gap-1.5 font-display text-lg text-white/75">
        <Radio aria-hidden="true" className="text-cyan-200/35" size={12} />
        {props.value}
      </div>
      <div className="font-mono text-[0.52rem] uppercase tracking-[0.1em] text-white/25">
        {props.label}
      </div>
    </div>
  );
}

function buildPluginRows(input: {
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
}): PluginRow[] {
  const names = new Set<string>();
  for (const plugin of input.plugins) names.add(plugin.name);
  for (const report of input.reports) names.add(report.pluginName);
  const loadedNames = new Set(input.plugins.map((plugin) => plugin.name));
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      loaded: loadedNames.has(name),
      name,
      report: input.reports.find((report) => report.pluginName === name),
    }));
}
