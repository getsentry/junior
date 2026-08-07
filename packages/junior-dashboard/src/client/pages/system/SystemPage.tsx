import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Navigate, useLocation } from "react-router";

import { agentNamePossessive, getDashboardAgentName } from "../../agentName";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import type { SystemData } from "../../types";
import { PluginDetails } from "./PluginDetails";
import { PluginPanels } from "./PluginPanels";
import { PluginReports } from "./PluginReports";
import { SkillInventory } from "./SkillInventory";
import { SystemActivity } from "./SystemActivity";
import { SystemPageLayout } from "./SystemPageLayout";
import {
  buildSystemPlugins,
  normalizeSystemPath,
  systemPluginPath,
  systemPluginsPath,
  type SystemPlugin,
} from "./SystemPlugins";

/**
 * Own System overview, plugin inventory, and plugin detail route selection,
 * redirecting paths that do not identify a loaded page.
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
  const pluginsPath = pathname === systemPluginsPath;
  const plugin = plugins.find(
    (candidate) => systemPluginPath(candidate.name) === pathname,
  );
  const pluginPath = pathname.startsWith(`${systemPluginsPath}/`);

  if (pluginPath && !plugin) {
    return <Navigate replace to={systemPluginsPath} />;
  }
  if (pathname !== "/system" && !pluginsPath && !plugin) {
    return <Navigate replace to="/system" />;
  }

  return (
    <SystemPageLayout>
      {plugin ? (
        <PluginSystemPage
          data={props.data}
          onRangeChange={setRange}
          plugin={plugin}
          range={range}
        />
      ) : pluginsPath ? (
        <PluginsSystemPage data={props.data} plugins={plugins} />
      ) : (
        <OverviewSystemPage
          data={props.data}
          range={range}
          onRangeChange={setRange}
        />
      )}
    </SystemPageLayout>
  );
}

function OverviewSystemPage(props: {
  data: SystemData;
  onRangeChange(value: TimeRangeDays): void;
  range: TimeRangeDays;
}) {
  return (
    <>
      <PageHeader
        actions={
          <TimeRangeSelector
            onChange={props.onRangeChange}
            value={props.range}
          />
        }
        description={`A live read on ${agentNamePossessive()} runtime and model usage.`}
        eyebrow={`${agentNamePossessive()} engine room`}
        title="System"
      />
      <SystemActivity
        error={props.data.conversationStatsError}
        range={props.range}
        loading={props.data.conversationStatsLoading}
        stats={props.data.conversationStats}
      />
    </>
  );
}

function PluginsSystemPage(props: {
  data: SystemData;
  plugins: SystemPlugin[];
}) {
  return (
    <>
      <PageHeader
        description={`Loaded capabilities and operational reports for ${getDashboardAgentName()}.`}
        eyebrow="System / capabilities"
        title="Plugins"
      />
      {props.data.pluginReportsError ? (
        <PluginReportError
          showingReports={props.plugins.some((plugin) => plugin.reports.length)}
        />
      ) : null}
      <PluginPanels plugins={props.plugins} />
      {props.data.skills.length ? (
        <SkillInventory skills={props.data.skills} />
      ) : null}
    </>
  );
}

function PluginSystemPage(props: {
  data: SystemData;
  onRangeChange(value: TimeRangeDays): void;
  plugin: SystemPlugin;
  range: TimeRangeDays;
}) {
  const reports = props.plugin.reports;
  const rangeRelevant = reports.some((report) =>
    report.widgets?.some((widget) => widget.timeRangeDays?.length),
  );

  return (
    <>
      <PageHeader
        actions={
          rangeRelevant ? (
            <TimeRangeSelector
              onChange={props.onRangeChange}
              value={props.range}
            />
          ) : undefined
        }
        description={props.plugin.description}
        eyebrow="System / plugins"
        title={props.plugin.displayName}
      />
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
          <div className="font-display text-sm font-medium text-dashboard-text-muted">
            Plugin stats failed to load.
          </div>
          <div className="mt-1 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            {props.showingReports
              ? `Showing the last operational reports ${getDashboardAgentName()} received.`
              : "Plugin details and capabilities are still available."}
          </div>
        </div>
      </div>
    </Card>
  );
}
