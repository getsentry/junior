import type { StorageMigrationResult } from "@sentry/junior-plugin-api";
import { pluginRuntimeRegistrationsFromPluginSet } from "@/plugins";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import { getChatConfig } from "@/chat/config";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
import { resolveUpgradePlugins } from "./upgrade-plugins";
import type { MigrationContext, MigrationResult } from "../types";

function emptyResult(): MigrationResult {
  return {
    existing: 0,
    migrated: 0,
    missing: 0,
    scanned: 0,
  };
}

function addResult(
  left: MigrationResult,
  right: StorageMigrationResult,
): MigrationResult {
  return {
    existing: left.existing + right.existing,
    migrated: left.migrated + right.migrated,
    missing: left.missing + right.missing,
    scanned: left.scanned + right.scanned,
    ...(left.skipped !== undefined || right.skipped !== undefined
      ? { skipped: (left.skipped ?? 0) + (right.skipped ?? 0) }
      : {}),
  };
}

function dbForPlugin(context: MigrationContext, sqlUrlDb: unknown): unknown {
  return context.db ?? sqlUrlDb ?? getDb();
}

/** Run plugin-owned storage migrations after plugin SQL schemas are available. */
export async function runPluginStorageMigrations(
  context: MigrationContext,
): Promise<MigrationResult> {
  const { pluginCatalogConfig, pluginSet } =
    await resolveUpgradePlugins(context);
  if (!pluginSet) {
    return emptyResult();
  }

  const previousConfig = setPluginCatalogConfig(pluginCatalogConfig);
  const ownedExecutor =
    context.db || !context.sqlDatabaseUrl
      ? undefined
      : createJuniorSqlExecutor({
          connectionString: context.sqlDatabaseUrl,
          driver: context.sqlDriver ?? getChatConfig().sql.driver,
        });
  const sqlUrlDb = ownedExecutor ? ownedExecutor.db() : undefined;
  try {
    let result = emptyResult();
    const plugins = pluginRuntimeRegistrationsFromPluginSet(pluginSet)
      .filter((plugin) => plugin.hooks?.migrateStorage)
      .sort((left, right) =>
        left.manifest.name.localeCompare(right.manifest.name),
      );
    for (const plugin of plugins) {
      const pluginName = plugin.manifest.name;
      const hook = plugin.hooks?.migrateStorage;
      if (!hook) {
        continue;
      }
      const db = dbForPlugin(context, sqlUrlDb);
      const pluginResult = await hook({
        db,
        log: createPluginLogger(pluginName),
        plugin: { name: pluginName },
        state: createPluginState(pluginName, context.stateAdapter),
      });
      if (pluginResult) {
        result = addResult(result, pluginResult);
      }
    }
    return result;
  } finally {
    setPluginCatalogConfig(previousConfig);
    await ownedExecutor?.close();
  }
}

export const pluginStorageMigration = {
  name: "run-plugin-storage-migrations",
  run: runPluginStorageMigrations,
};
