import { TriangleAlert } from "lucide-react";

import { PluginReports } from "../../components/PluginReports";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { cn, dashboardContainerClass } from "../../styles";
import type { SystemData } from "../../types";
import { PluginInventory } from "./PluginInventory";
import { SystemActivity } from "./SystemActivity";

/** Render aggregate system activity with plugin inventory and reports. */
export function SystemPage(props: { data: SystemData }) {
  const reports = props.data.pluginReports?.reports ?? [];
  const reportsPending =
    props.data.pluginReportsLoading && reports.length === 0;
  const reportEmptyText = props.data.pluginReportsError
    ? undefined
    : props.data.pluginReportsLoading
      ? "Loading plugin stats."
      : "No plugins have been reported yet.";

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        description="A live read on Junior's runtime, model usage, loaded capabilities, and the systems keeping work moving."
        eyebrow="Junior's engine room"
        title="System"
      />

      <SystemActivity
        error={props.data.conversationStatsError}
        loading={props.data.conversationStatsLoading}
        stats={props.data.conversationStats}
      />

      <PluginInventory
        loadingReports={reportsPending}
        plugins={props.data.plugins}
        reports={reports}
        skills={props.data.skills}
      />

      {props.data.pluginReportsError ? (
        <Card className="border-amber-300/10 bg-amber-300/[0.025]" padding="sm">
          <div className="flex items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded border border-amber-300/15 bg-amber-300/[0.055] text-amber-200/70">
              <TriangleAlert aria-hidden="true" size={15} />
            </div>
            <div>
              <div className="font-display text-sm font-medium text-white/75">
                Plugin stats failed to load.
              </div>
              <div className="mt-1 font-mono text-[0.64rem] leading-relaxed text-white/30">
                {reports.length
                  ? "Showing the last operational reports Junior received."
                  : "Loaded capabilities are still available above."}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <PluginReports emptyText={reportEmptyText} reports={reports} />
    </div>
  );
}
