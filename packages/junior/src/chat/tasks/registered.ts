import type { RegisteredTaskSummary } from "@/api/schema/task";
import { readNamedStats } from "@/stats";

/** Load registered plugin background tasks with run frequency and recency. */
export async function readRegisteredTasks(): Promise<RegisteredTaskSummary[]> {
  const [{ getPlugins }, { pluginCatalogRuntime }] = await Promise.all([
    import("@/chat/plugins/agent-hooks"),
    import("@/chat/plugins/catalog-runtime"),
  ]);
  const runtimePlugins = new Map(
    getPlugins().map((plugin) => [plugin.manifest.name, plugin]),
  );
  const providers = pluginCatalogRuntime.getProviders();
  const sevenDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const pluginTaskStats = new Map(
    await Promise.all(
      providers.map(
        async (plugin) =>
          [
            plugin.manifest.name,
            await readNamedStats(
              plugin.manifest.name,
              "task.execution.registered",
            ),
          ] as const,
      ),
    ),
  );

  return providers
    .flatMap((plugin) => {
      const taskNames = Object.keys(
        runtimePlugins.get(plugin.manifest.name)?.tasks ?? {},
      ).sort((left, right) => left.localeCompare(right));
      return taskNames.map((name) => {
        const stats = (pluginTaskStats.get(plugin.manifest.name) ?? []).filter(
          (stat) => stat.name === name,
        );
        const lastRunAtMs = Math.max(
          ...stats.map((stat) => stat.lastOccurredAtMs ?? 0),
        );
        return {
          id: `${plugin.manifest.name}:${name}`,
          name,
          pluginDisplayName: plugin.manifest.displayName,
          pluginName: plugin.manifest.name,
          runsLast7Days: stats
            .filter((stat) => stat.date >= sevenDaysAgo)
            .reduce((total, stat) => total + stat.count, 0),
          totalRuns: stats.reduce((total, stat) => total + stat.count, 0),
          ...(lastRunAtMs > 0
            ? { lastRunAt: new Date(lastRunAtMs).toISOString() }
            : {}),
        } satisfies RegisteredTaskSummary;
      });
    })
    .sort(
      (left, right) =>
        left.pluginDisplayName.localeCompare(right.pluginDisplayName) ||
        left.name.localeCompare(right.name),
    );
}
