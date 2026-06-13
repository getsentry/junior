import { getChatConfig } from "@/chat/config";
import { migratePluginSchemas, readPluginMigrations } from "@/chat/plugins/db";
import {
  getPluginMigrationRoots,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import type { MigrationContext, MigrationResult } from "../types";

const REQUIRED_SQL_DATABASE_URL_MESSAGE =
  "Junior SQL database URL is required for plugin schema upgrade. Set JUNIOR_DATABASE_URL or DATABASE_URL.";

function readEnvPluginCatalogConfig(): PluginCatalogConfig | undefined {
  const raw = process.env.JUNIOR_PLUGIN_PACKAGES;
  if (!raw) {
    return undefined;
  }
  let packages: unknown;
  try {
    packages = JSON.parse(raw);
  } catch (error) {
    throw new Error("JUNIOR_PLUGIN_PACKAGES must be valid JSON", {
      cause: error,
    });
  }
  if (
    !Array.isArray(packages) ||
    packages.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(
      "JUNIOR_PLUGIN_PACKAGES must be a JSON array of package names",
    );
  }
  return { packages };
}

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
  const previousConfig = setPluginCatalogConfig(
    context.pluginCatalogConfig ?? readEnvPluginCatalogConfig(),
  );
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
