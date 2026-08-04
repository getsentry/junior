/**
 * SQL-only upgrade entry point.
 *
 * It applies core and enabled-plugin Drizzle migrations through one owned
 * executor; legacy state conversion belongs to the required bridge release.
 */
import { getChatConfig } from "@/chat/config";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createJiti } from "jiti";
import { loadAppPluginSet } from "@/plugin-module";
import { migratePluginsToSql } from "./upgrade/migrations/plugin-sql";
import type {
  MigrationSummary,
  UpgradeContext,
  UpgradeIo,
} from "./upgrade/types";
import { type JuniorPluginSet } from "@/plugins";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";

const DEFAULT_IO: UpgradeIo = {
  info: console.log,
};
const localPluginLoader = createJiti(import.meta.url, { moduleCache: false });

function isMissingVirtualConfig(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND") &&
    error.message.includes("#junior/config")
  );
}

/** Resolve the plugin set available to upgrade migrations in source and built CLI runs. */
export async function resolveUpgradePluginSet(): Promise<
  JuniorPluginSet | undefined
> {
  try {
    const mod: {
      pluginSet?: JuniorPluginSet;
    } = await import("#junior/config");
    return mod.pluginSet;
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
  }

  return await loadAppPluginSet(process.cwd(), async (moduleRef) =>
    localPluginLoader.import<Record<string, unknown>>(moduleRef.importPath),
  );
}

function migrationCount(count: number): string {
  return `${count} ${count === 1 ? "migration" : "migrations"}`;
}

function formatOwnerSummary(owner: string, summary: MigrationSummary): string {
  if (summary.migrated === 0) {
    return `  ${owner}: up to date (${migrationCount(summary.scanned)})`;
  }
  return `  ${owner}: applied ${migrationCount(summary.migrated)} (${summary.scanned} total)`;
}

function pluginMigrationOwner(pluginName: string): string {
  const unscopedName = pluginName.split("/").at(-1) ?? pluginName;
  return unscopedName.startsWith("junior-")
    ? unscopedName
    : `junior-${unscopedName}`;
}

async function runDatabaseMigrations(
  context: UpgradeContext,
  io: UpgradeIo,
): Promise<void> {
  io.info("Checking database migrations...");
  const core = await migrateSchema(context.sqlExecutor);
  io.info(formatOwnerSummary("junior", core));

  const plugins = await migratePluginsToSql(context, {
    onPluginMigration: (summary) => {
      io.info(
        formatOwnerSummary(pluginMigrationOwner(summary.pluginName), summary),
      );
    },
  });
  const migrated = core.migrated + plugins.migrated;
  const scanned = core.scanned + plugins.scanned;
  io.info(
    migrated === 0
      ? `Database is up to date (${migrationCount(scanned)}).`
      : `Applied ${migrationCount(migrated)} (${scanned} total).`,
  );
}

/** Apply Junior and enabled-plugin database migrations. */
export async function runUpgrade(
  io: UpgradeIo = DEFAULT_IO,
  options: { pluginSet?: JuniorPluginSet | null } = {},
): Promise<void> {
  const { sql } = getChatConfig();
  const sqlExecutor: JuniorSqlExecutor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
    statementTimeoutMs: false,
  });
  try {
    const pluginSet =
      options.pluginSet === undefined
        ? await resolveUpgradePluginSet()
        : (options.pluginSet ?? undefined);
    await runDatabaseMigrations(
      {
        pluginSet,
        sqlExecutor,
      },
      io,
    );
  } finally {
    await sqlExecutor.close();
  }
}
