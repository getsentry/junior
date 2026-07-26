import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Navigate, useLocation } from "react-router";

import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { PluginReports } from "../../components/PluginReports";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { cn, dashboardContainerClass } from "../../styles";
import type { SystemData } from "../../types";
import { PluginDetails, PluginHeader } from "./PluginDetails";
import { PluginPanels } from "./PluginPanels";
import { SkillInventory } from "./SkillInventory";
import { SystemActivity } from "./SystemActivity";
import { SystemNavigation } from "./SystemNavigation";
import {
  buildSystemPlugins,
  normalizeSystemPath,
  systemPluginPath,
  type SystemPlugin,
} from "./SystemPlugins";

/**
 * Own `/system/*` route selection between the aggregate overview and loaded
 * plugin pages, redirecting paths that do not identify a loaded plugin.
 */
export function SystemPage(props: { data: SystemData }) {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const location = useLocation();
  const reports = props.data.pluginReports?.reports ?? [];
  const plugins = buildSystemPlugins({
    plugins: props.data.plugins,
    reports,
    skills: props.data.skills,
  });
  const pathname = normalizeSystemPath(location.pathname);
  const plugin = plugins.find(
    (candidate) => systemPluginPath(candidate.name) === pathname,
  );
  const pluginPath = pathname !== "/system";
  const rangeRelevant =
    !plugin ||
    plugin.reports.some((report) =>
      report.widgets?.some((widget) => widget.timeRangeDays?.length),
    );

  if (pluginPath && !plugin) {
    return <Navigate replace to="/system" />;
  }

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        actions={
          rangeRelevant ? (
            <TimeRangeSelector onChange={setRange} value={range} />
          ) : undefined
        }
        description="A live read on Junior's runtime, model usage, loaded capabilities, and the systems keeping work moving."
        eyebrow="Junior's engine room"
        title="System"
      />

      <div className="grid min-w-0 items-start gap-4 sm:gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SystemNavigation plugins={plugins} />
        <div className="grid min-w-0 gap-4 sm:gap-6">
          {plugin ? (
            <PluginSystemPage data={props.data} plugin={plugin} range={range} />
          ) : (
            <>
              <SystemActivity
                error={props.data.conversationStatsError}
                range={range}
                loading={props.data.conversationStatsLoading}
                stats={props.data.conversationStats}
              />
              {props.data.pluginReportsError ? (
                <PluginReportError showingReports={false} />
              ) : null}
              <PluginPanels plugins={plugins} />
              {props.data.skills.length ? (
                <SkillInventory skills={props.data.skills} />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PluginSystemPage(props: {
  data: SystemData;
  plugin: SystemPlugin;
  range: TimeRangeDays;
}) {
  const reports = props.plugin.reports;

  return (
    <>
      <PluginHeader plugin={props.plugin} />
      {props.data.pluginReportsError ? (
        <PluginReportError showingReports={Boolean(reports.length)} />
      ) : null}
      <PluginDetails plugin={props.plugin} />
      <PluginReports
        fallbackTitle={props.plugin.displayName}
        {...(!props.data.pluginReportsLoading && !props.data.pluginReportsError
          ? {
              emptyText:
                "This plugin does not expose operational activity yet.",
            }
          : {})}
        range={props.range}
        reports={reports}
      />
    </>
  );
}

function PluginReportError(props: { showingReports: boolean }) {
  return (
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
            {props.showingReports
              ? "Showing the last operational reports Junior received."
              : "Plugin details and capabilities are still available."}
          </div>
        </div>
      </div>
    </Card>
  );
}
