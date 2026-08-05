import type { RegisteredTaskSummary } from "@/api/schema/task";
import { readTaskExecutionSummaries } from "@/chat/tasks/execution-stats";

/** Load registered plugin background tasks with execution analytics. */
export async function readRegisteredTasks(): Promise<RegisteredTaskSummary[]> {
  const [{ getPlugins }, { pluginCatalogRuntime }] = await Promise.all([
    import("@/chat/plugins/agent-hooks"),
    import("@/chat/plugins/catalog-runtime"),
  ]);
  const runtimePlugins = new Map(
    getPlugins().map((plugin) => [plugin.manifest.name, plugin]),
  );
  const providers = pluginCatalogRuntime.getProviders();
  const pluginTaskStats = new Map(
    await Promise.all(
      providers.map(
        async (plugin) =>
          [
            plugin.manifest.name,
            await readTaskExecutionSummaries(
              "registered",
              plugin.manifest.name,
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
        const stats = pluginTaskStats.get(plugin.manifest.name)?.get(name);
        return {
          id: `${plugin.manifest.name}:${name}`,
          name,
          pluginDisplayName: plugin.manifest.displayName,
          pluginName: plugin.manifest.name,
          runsLast7Days: stats?.runsLast7Days ?? 0,
          totalRuns: stats?.totalRuns ?? 0,
          ...(stats?.lastConversationId
            ? { lastConversationId: stats.lastConversationId }
            : {}),
          ...(stats?.lastExecutedAtMs
            ? {
                lastRunAt: new Date(stats.lastExecutedAtMs).toISOString(),
              }
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
