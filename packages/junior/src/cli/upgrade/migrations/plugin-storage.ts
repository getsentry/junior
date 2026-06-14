import type {
  PluginDb,
  PluginRegistration,
  StorageMigrationResult,
} from "@sentry/junior-plugin-api";
import {
  pluginCatalogConfigFromPluginSet,
  pluginHookRegistrationsFromPluginSet,
} from "@/plugins";
import {
  createPluginDbForExecutor,
  getPluginDbForRegistration,
} from "@/chat/plugins/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
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

function dbForPlugin(
  context: MigrationContext,
  plugin: PluginRegistration,
  sqlUrlDb: PluginDb | undefined,
): PluginDb | undefined {
  if (!plugin.database) {
    return undefined;
  }
  return context.pluginDb ?? sqlUrlDb ?? getPluginDbForRegistration(plugin);
}

/** Run plugin-owned storage migrations after plugin SQL schemas are available. */
export async function runPluginStorageMigrations(
  context: MigrationContext,
): Promise<MigrationResult> {
  const pluginSet = context.pluginSet;
  if (!pluginSet) {
    return emptyResult();
  }

  const previousConfig = setPluginCatalogConfig(
    context.pluginCatalogConfig ?? pluginCatalogConfigFromPluginSet(pluginSet),
  );
  const ownedExecutor =
    context.pluginDb || !context.sqlDatabaseUrl
      ? undefined
      : createNeonJuniorSqlExecutor({
          connectionString: context.sqlDatabaseUrl,
        });
  const sqlUrlDb = ownedExecutor
    ? createPluginDbForExecutor(ownedExecutor)
    : undefined;
  try {
    let result = emptyResult();
    const plugins = pluginHookRegistrationsFromPluginSet(pluginSet)
      .filter((plugin) => plugin.hooks?.migrateStorage)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const plugin of plugins) {
      const hook = plugin.hooks?.migrateStorage;
      if (!hook) {
        continue;
      }
      const pluginResult = await hook({
        db: dbForPlugin(context, plugin, sqlUrlDb),
        log: createPluginLogger(plugin.name),
        plugin: { name: plugin.name },
        state: createPluginState(plugin.name, context.stateAdapter),
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
