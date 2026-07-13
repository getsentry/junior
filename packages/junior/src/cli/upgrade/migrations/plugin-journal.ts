import { getChatConfig } from "@/chat/config";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { createJuniorSqlExecutor } from "@/db/executor";
import { createJiti } from "jiti";
import { resolveUpgradePlugins } from "./upgrade-plugins";
import type { MigrationContext, MigrationResult } from "../types";

const migrationLoader = createJiti(import.meta.url, { moduleCache: false });

/** Apply mixed migration journals owned by explicitly enabled plugins. */
export async function migratePluginJournals(
  context: MigrationContext,
): Promise<MigrationResult> {
  const { sql } = getChatConfig();
  const { pluginCatalogConfig, pluginSet } =
    await resolveUpgradePlugins(context);
  const previousConfig = pluginCatalogRuntime.setConfig(pluginCatalogConfig);
  const executor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
  try {
    const registrations = new Map(
      pluginSet
        ? pluginSet.registrations.map((plugin) => [
            plugin.manifest.name,
            plugin,
          ])
        : [],
    );
    const result = await migratePluginSchemas(
      executor,
      pluginCatalogRuntime.getMigrationRoots(),
      {
        loadTypeScript: async (path) =>
          await migrationLoader.import<Record<string, unknown>>(path),
        log: context.io.info,
        mode: "all",
        runTask: async (pluginName, taskName) => {
          const task =
            registrations.get(pluginName)?.migrationTasks?.[taskName];
          if (!task) {
            throw new Error(
              `Plugin ${pluginName} does not provide migration task ${taskName}`,
            );
          }
          return await task({
            db: context.db ?? executor.db(),
            log: createPluginLogger(pluginName),
            state: createPluginState(pluginName, context.stateAdapter),
          });
        },
        stateAdapter: context.stateAdapter,
      },
    );
    return {
      existing: result.existing,
      migrated: result.migrated,
      missing: 0,
      scanned: result.scanned,
      ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
    };
  } finally {
    pluginCatalogRuntime.setConfig(previousConfig);
    await executor.close();
  }
}
