import type {
  PluginOperationalReport,
  Plugin,
  SkillReport,
} from "@sentry/junior/api/schema";

export type SystemPlugin = Plugin & {
  reports: PluginOperationalReport[];
  skills: SkillReport[];
};

/** Canonical System route for the complete plugin inventory. */
export const systemPluginsPath = "/system/plugins";

/** Combine plugin inventory, skills, and operational reports for System UI. */
export function buildSystemPlugins(input: {
  plugins: Plugin[];
  reports: PluginOperationalReport[];
  skills: SkillReport[];
}): SystemPlugin[] {
  const plugins = new Map(
    input.plugins.map((plugin) => [
      plugin.name,
      {
        ...plugin,
        reports: [] as PluginOperationalReport[],
        skills: [] as SkillReport[],
      },
    ]),
  );

  for (const skill of input.skills) {
    const plugin = skill.pluginProvider
      ? plugins.get(skill.pluginProvider)
      : undefined;
    if (plugin) plugin.skills.push(skill);
  }
  for (const report of input.reports) {
    plugins.get(report.pluginName)?.reports.push(report);
  }

  return [...plugins.values()]
    .map((plugin) => ({
      ...plugin,
      reports: [...plugin.reports],
      skills: [...plugin.skills].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Build the canonical System route for a plugin name. */
export function systemPluginPath(name: string): string {
  return `${systemPluginsPath}/${encodeURIComponent(name)}`;
}

/** Treat trailing slashes as equivalent on System routes. */
export function normalizeSystemPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}
