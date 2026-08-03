import { usePluginReportsData, usePluginsData, useSkillsData } from "../../api";
import { buildSystemPlugins, type SystemPlugin } from "./SystemPlugins";

export type SystemNavigationData = {
  plugins: SystemPlugin[];
  reportingPlugins: SystemPlugin[];
};

export const emptySystemNavigationData: SystemNavigationData = {
  plugins: [],
  reportingPlugins: [],
};

/** Load the plugin data needed to keep System navigation consistent. */
export function useSystemNavigationData(): SystemNavigationData {
  const pluginsQuery = usePluginsData();
  const skillsQuery = useSkillsData();
  const pluginReportsQuery = usePluginReportsData();
  if (!pluginsQuery.data || !skillsQuery.data) {
    return emptySystemNavigationData;
  }

  const plugins = buildSystemPlugins({
    plugins: pluginsQuery.data,
    reports: pluginReportsQuery.data?.reports ?? [],
    skills: skillsQuery.data,
  });
  return {
    plugins,
    reportingPlugins: pluginReportsQuery.isPending
      ? plugins
      : plugins.filter((plugin) => plugin.reports.length),
  };
}
