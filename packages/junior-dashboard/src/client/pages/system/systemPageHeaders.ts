import { agentNamePossessive, getDashboardAgentName } from "../../agentName";
import {
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { normalizeSystemPath, systemPluginsPath } from "./SystemPlugins";

type SystemPageHeader = { description: string; title: string };

// Pages and their route loading states read the same header text, so the
// header keeps its height when the page finishes loading.

/** Header text for the System overview. */
export function systemOverviewHeader(): SystemPageHeader {
  return {
    description: `A live read on ${agentNamePossessive()} runtime and model usage.`,
    title: "System",
  };
}

/** Header text for the Plugins list. */
export function systemPluginsHeader(): SystemPageHeader {
  return {
    description: `Loaded capabilities and operational reports for ${getDashboardAgentName()}.`,
    title: "Plugins",
  };
}

/** Header text for one plugin before its details load. */
export function systemPluginLoadingHeader(): SystemPageHeader {
  return {
    description: "Loading plugin details and operational reports.",
    title: "Plugin",
  };
}

/** Reporting window that People opens with. */
export const PEOPLE_DEFAULT_RANGE: TimeRangeDays = 7;

/** Header text for People in one reporting window. */
export function peopleHeader(range: TimeRangeDays): SystemPageHeader {
  return {
    description: `Who used ${getDashboardAgentName()} in the ${timeRangeDetail(range)}, and how spend changed from the prior period.`,
    title: "People",
  };
}

/** Header text for Locations. */
export function locationsHeader(): SystemPageHeader {
  return {
    description: `See the public channels where ${getDashboardAgentName()} has been working and how busy they've been.`,
    title: "Locations",
  };
}

/** Header text for Workspaces. */
export function workspacesHeader(): SystemPageHeader {
  return {
    description: `Named repository recipes ${getDashboardAgentName()} can switch into without cloning each turn.`,
    title: "Workspaces",
  };
}

/** Header text for a `/system/*` route that is still loading. */
export function systemRouteLoadingHeader(path: string): SystemPageHeader {
  const pathname = normalizeSystemPath(path);
  if (pathname === systemPluginsPath) return systemPluginsHeader();
  if (pathname.startsWith(`${systemPluginsPath}/`)) {
    return systemPluginLoadingHeader();
  }
  return systemOverviewHeader();
}
