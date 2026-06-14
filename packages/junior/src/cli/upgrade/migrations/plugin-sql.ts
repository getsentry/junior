import { getChatConfig } from "@/chat/config";
import { migratePluginSchemas, readPluginMigrations } from "@/chat/plugins/db";
import {
  getPluginMigrationRoots,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
import { resolveUpgradePlugins } from "./upgrade-plugins";
import type { MigrationContext, MigrationResult } from "../types";

const REQUIRED_SQL_DATABASE_URL_MESSAGE =
  "Junior SQL database URL is required for plugin schema migration. Set JUNIOR_DATABASE_URL or DATABASE_URL.";

function requirePluginSqlDatabaseUrl(context: MigrationContext): string {
  const databaseUrl = context.sqlDatabaseUrl ?? getChatConfig().sql.databaseUrl;
  if (!databaseUrl) {
    throw new Error(REQUIRED_SQL_DATABASE_URL_MESSAGE);
  }
  return databaseUrl;
}

/** Apply SQL schema migrations owned by explicitly enabled plugins. */
export async function migratePluginsToSql(
  context: MigrationContext,
): Promise<MigrationResult> {
  const databaseUrl = requirePluginSqlDatabaseUrl(context);
  const { pluginCatalogConfig } = await resolveUpgradePlugins(context);
  const previousConfig = setPluginCatalogConfig(pluginCatalogConfig);
  const executor = createNeonJuniorSqlExecutor({
    connectionString: databaseUrl,
  });
  try {
    const migrations = getPluginMigrationRoots().flatMap((root) =>
      readPluginMigrations(root),
    );
    const result = await migratePluginSchemas(executor, migrations);
    return {
      existing: result.existing,
      migrated: result.migrated,
      missing: 0,
      scanned: result.scanned,
    };
  } finally {
    setPluginCatalogConfig(previousConfig);
    await executor.close();
  }
}

export const sqlPluginMigration = {
  name: "migrate-plugin-sql",
  run: migratePluginsToSql,
};
