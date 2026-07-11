import { getChatConfig } from "@/chat/config";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { createJuniorSqlExecutor } from "@/db/executor";
import { resolveUpgradePlugins } from "./upgrade-plugins";
import type { MigrationContext, MigrationResult } from "../types";

/** Apply SQL schema migrations owned by explicitly enabled plugins. */
export async function migratePluginsToSql(
  context: MigrationContext,
): Promise<MigrationResult> {
  const { sql } = getChatConfig();
  const { pluginCatalogConfig } = await resolveUpgradePlugins(context);
  const previousConfig = pluginCatalogRuntime.setConfig(pluginCatalogConfig);
  const executor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
  try {
    const result = await migratePluginSchemas(
      executor,
      pluginCatalogRuntime.getMigrationRoots(),
    );
    return {
      existing: result.existing,
      migrated: result.migrated,
      missing: 0,
      scanned: result.scanned,
    };
  } finally {
    pluginCatalogRuntime.setConfig(previousConfig);
    await executor.close();
  }
}

export const sqlPluginMigration = {
  name: "migrate-plugin-sql",
  run: migratePluginsToSql,
};
