import { Boxes } from "lucide-react";
import type {
  PluginOperationalReport,
  PluginReport,
} from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";

type PluginRow = {
  name: string;
};

/** Present loaded plugins as an operational capability roster. */
export function PluginInventory(props: {
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
}) {
  const rows = buildPluginRows(props);
  return (
    <Card>
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
          Capability map
        </div>
        <h2 className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-white">
          Plugins
        </h2>
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
  return (
    <article className="flex min-w-0 items-center gap-2.5 rounded-lg border border-white/[0.065] bg-white/[0.025] px-4 py-2.5 transition-colors hover:border-white/[0.11] hover:bg-white/[0.035]">
      <div className="grid size-7 shrink-0 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-200">
        <Boxes aria-hidden="true" size={14} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 truncate font-display text-base font-medium text-white">
        {props.row.name}
      </div>
    </article>
  );
}

function buildPluginRows(input: {
  plugins: PluginReport[];
  reports: PluginOperationalReport[];
}): PluginRow[] {
  const names = new Set<string>();
  for (const plugin of input.plugins) names.add(plugin.name);
  for (const report of input.reports) names.add(report.pluginName);
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}
