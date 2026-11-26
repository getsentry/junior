import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Navigate, useLocation } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { useConversationStatsData, useSystemPluginsData } from "../../api";
import { LoadingView } from "../../components/LoadingView";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";

import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import type { DashboardCoreData, SystemPluginsData } from "../../types";
import { CacheHealth } from "./CacheHealth";
import { CacheWarmingSavings } from "./CacheWarmingSavings";
import { PluginDetails } from "./PluginDetails";
import { PluginPanels } from "./PluginPanels";
import { PluginReports } from "./PluginReports";
import { SkillInventory } from "./SkillInventory";
import { SystemActivity } from "./SystemActivity";
import {
  SystemPageLayout,
  SystemRouteLoading,
  systemOverviewDefaultRange,
  systemOverviewDescription,
} from "./SystemPageLayout";
import {
  buildSystemPlugins,
  normalizeSystemPath,
  systemPluginPath,
  systemPluginsPath,
  type SystemPlugin,
} from "./SystemPlugins";

/**
 * Own System overview, plugin inventory, and plugin detail route selection,
 * redirecting paths that do not identify a page.
 */
export function SystemPage(props: { coreData: DashboardCoreData }) {
  const [range, setRange] = useState<TimeRangeDays>(systemOverviewDefaultRange);
  const pathname = normalizeSystemPath(useLocation().pathname);

  if (pathname === "/system") {
    return (
      <SystemPageLayout>
        <OverviewSystemPage
          admin={props.coreData.me.user.isAdmin}
          range={range}
          onRangeChange={setRange}
        />
      </SystemPageLayout>
    );
  }
  if (
    pathname !== systemPluginsPath &&
    !pathname.startsWith(`${systemPluginsPath}/`)
  ) {
    return <Navigate replace to="/system" />;
  }
  return (
    <PluginsRoute pathname={pathname} range={range} onRangeChange={setRange} />
  );
}

// Only the Plugins pages wait on the plugin inventory and its reports.
function PluginsRoute(props: {
  onRangeChange(value: TimeRangeDays): void;
  pathname: string;
  range: TimeRangeDays;
}) {
  const query = useSystemPluginsData();
  const pluginsPath = props.pathname === systemPluginsPath;
  if (!query.data) {
    return query.error ? (
      <SystemPageLayout>
        <LoadingView label={query.error.message} />
      </SystemPageLayout>
    ) : (
      <SystemRouteLoading
        description="Loaded capabilities and operational reports."
        label={pluginsPath ? "Loading plugins" : "Loading plugin"}
        title={pluginsPath ? "Plugins" : "Plugin"}
      />
    );
  }

  const data = query.data;
  const plugins = buildSystemPlugins({
    plugins: data.plugins,
    reports: data.pluginReports?.reports ?? [],
    skills: data.skills,
  });
  const plugin = plugins.find(
    (candidate) => systemPluginPath(candidate.name) === props.pathname,
  );

  if (!pluginsPath && !plugin && data.pluginReportsLoading) {
    return (
      <SystemRouteLoading
        description="Loading plugin details and operational reports."
        label="Loading plugin"
        title="Plugin"
      />
    );
  }
  if (!pluginsPath && !plugin) {
    return <Navigate replace to={systemPluginsPath} />;
  }

  return (
    <SystemPageLayout>
      {plugin ? (
        <PluginSystemPage
          data={data}
          onRangeChange={props.onRangeChange}
          plugin={plugin}
          range={props.range}
        />
      ) : (
        <PluginsSystemPage data={data} plugins={plugins} />
      )}
    </SystemPageLayout>
  );
}

function OverviewSystemPage(props: {
  admin: boolean;
  onRangeChange(value: TimeRangeDays): void;
  range: TimeRangeDays;
}) {
  const stats = useConversationStatsData();
  return (
    <>
      <PageHeader
        description={systemOverviewDescription()}
        onRangeChange={props.onRangeChange}
        range={props.range}
        title="System"
      />
      <SystemActivity
        error={Boolean(stats.error)}
        range={props.range}
        loading={stats.isPending}
        stats={stats.data}
      />
      <CacheWarmingSavings admin={props.admin} range={props.range} />
      <CacheHealth range={props.range} />
    </>
  );
}

function PluginsSystemPage(props: {
  data: SystemPluginsData;
  plugins: SystemPlugin[];
}) {
  return (
    <>
      <PageHeader
        description={`Loaded capabilities and operational reports for ${getDashboardAgentName()}.`}
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
  data: SystemPluginsData;
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
        description={props.plugin.description}
        {...(rangeRelevant
          ? { onRangeChange: props.onRangeChange, range: props.range }
          : {})}
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
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-amber-300/15 bg-amber-300/[0.055] text-amber-200/70">
          <TriangleAlert aria-hidden="true" size={15} />
        </div>
        <div>
          <div className="font-display text-sm font-medium text-dashboard-text-muted">
            Plugin stats failed to load.
          </div>
          <div className="mt-1 font-sans text-xs leading-relaxed text-dashboard-text-muted">
            {props.showingReports
              ? `Showing the last operational reports ${getDashboardAgentName()} received.`
              : "Plugin details and capabilities are still available."}
          </div>
        </div>
      </div>
    </Card>
  );
}
