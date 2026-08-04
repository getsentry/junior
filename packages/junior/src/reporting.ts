import { readFileSync } from "node:fs";
import path from "node:path";
import { readNamedStats } from "./stats";
import {
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  runtimeInfoReportSchema,
  skillReportsSchema,
} from "./reporting-schema";
import type {
  PluginOperationalReportFeed,
  Plugin,
  RuntimeInfoReport,
  SkillReport,
} from "./reporting-schema";

export {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginOperationalReportSchema,
  pluginPackageContentItemReportSchema,
  pluginPackageContentReportSchema,
  pluginSchema,
  pluginsSchema,
  runtimeInfoReportSchema,
  skillReportSchema,
  skillReportsSchema,
} from "./reporting-schema";
export { readHealthReport } from "./handlers/health";
export type {
  HealthReport,
  PluginOperationalReport,
  PluginOperationalReportFeed,
  PluginPackageContentItemReport,
  PluginPackageContentReport,
  Plugin,
  Plugins,
  RuntimeInfoReport,
  SkillReport,
  SkillReports,
} from "./reporting-schema";

function readDescriptionText(home: string): string | undefined {
  try {
    const raw = readFileSync(path.join(home, "DESCRIPTION.md"), "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Read discovered skill names for authenticated runtime diagnostics. */
export async function readSkillReports(): Promise<SkillReport[]> {
  const { discoverSkills } = await import("@/chat/skills");
  const skills = await discoverSkills();
  return skillReportsSchema.parse(
    skills.map((skill) => ({
      name: skill.name,
      pluginProvider: skill.pluginProvider,
    })),
  );
}

/** Read safe configured plugin metadata for authenticated runtime diagnostics. */
export async function readPlugins(): Promise<Plugin[]> {
  const [{ pluginCatalogRuntime }, { getPlugins }] = await Promise.all([
    import("@/chat/plugins/catalog-runtime"),
    import("@/chat/plugins/agent-hooks"),
  ]);
  const registeredPlugins = new Map(
    getPlugins().map((plugin) => [plugin.manifest.name, plugin]),
  );
  const pluginTaskStats = new Map(
    await Promise.all(
      pluginCatalogRuntime
        .getProviders()
        .map(
          async (plugin) =>
            [
              plugin.manifest.name,
              await readNamedStats(plugin.manifest.name, "task.completed"),
            ] as const,
        ),
    ),
  );
  const sevenDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return pluginsSchema.parse(
    pluginCatalogRuntime.getProviders().map((plugin) => ({
      configKeys: plugin.manifest.configKeys ?? [],
      description: plugin.manifest.description,
      displayName: plugin.manifest.displayName,
      name: plugin.manifest.name,
      tasks: Object.keys(
        registeredPlugins.get(plugin.manifest.name)?.tasks ?? {},
      ).map((name) => {
        const stats = (pluginTaskStats.get(plugin.manifest.name) ?? []).filter(
          (stat) => stat.name === name,
        );
        const lastRunAtMs = Math.max(
          ...stats.map((stat) => stat.lastOccurredAtMs ?? 0),
        );
        return {
          name,
          totalRuns: stats.reduce((total, stat) => total + stat.count, 0),
          runsLast7Days: stats
            .filter((stat) => stat.date >= sevenDaysAgo)
            .reduce((total, stat) => total + stat.count, 0),
          ...(lastRunAtMs > 0
            ? { lastRunAt: new Date(lastRunAtMs).toISOString() }
            : {}),
        };
      }),
    })),
  );
}

/** Read authenticated runtime discovery data. */
export async function readRuntimeInfoReport(): Promise<RuntimeInfoReport> {
  const [{ homeDir }, { pluginCatalogRuntime }, plugins, skills] =
    await Promise.all([
      import("@/chat/discovery"),
      import("@/chat/plugins/catalog-runtime"),
      readPlugins(),
      readSkillReports(),
    ]);
  const home = homeDir();

  return runtimeInfoReportSchema.parse({
    cwd: process.cwd(),
    homeDir: home,
    descriptionText: readDescriptionText(home),
    providers: plugins.map((plugin) => plugin.name),
    skills,
    packagedContent: pluginCatalogRuntime.getPackageContent(),
  });
}

/** Read sanitized operational summaries contributed by plugins. */
export async function readPluginOperationalReportFeed(): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  const { getPluginOperationalReports } =
    await import("@/chat/plugins/agent-hooks");
  return pluginOperationalReportFeedSchema.parse({
    source: "plugins",
    generatedAt: new Date(nowMs).toISOString(),
    reports: await getPluginOperationalReports(nowMs),
  });
}
