import { getChatConfig } from "@/chat/config";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
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
      {
        loadTypeScript: async (path) =>
          await migrationLoader.import<Record<string, unknown>>(path),
        log: context.io.info,
        mode: "all",
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
