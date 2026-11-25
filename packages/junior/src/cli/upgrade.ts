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
import { readMigrationDatabaseUrl } from "./upgrade/database-url";
import { migratePluginsToSql } from "./upgrade/migrations/plugin-sql";
import type {
  MigrationSummary,
  UpgradeContext,
  UpgradeIo,
} from "./upgrade/types";
import { type JuniorPluginSet } from "@/plugins";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import { isMissingVirtualModule } from "@/virtual-module";

const DEFAULT_IO: UpgradeIo = {
  info: console.log,
};
const localPluginLoader = createJiti(import.meta.url, { moduleCache: false });

/** Resolve the plugin set available to upgrade migrations in source and built CLI runs. */
export async function resolveUpgradePluginSet(): Promise<
  JuniorPluginSet | undefined
> {
  try {
    const mod: {
      pluginSet?: JuniorPluginSet | undefined;
    } = await import("#junior/config");
    return mod.pluginSet;
  } catch (error) {
    if (!isMissingVirtualModule(error, "#junior/config")) {
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
  await setJitThreshold(context.sqlExecutor, io);
}

// Postgres JIT-compiles a plan whose cost is above `jit_above_cost`
// (default 100000). On 114k seeded Conversations, 13 app reads planned
// between 100k and 863k, mostly from misestimated subtree and status
// subqueries. Each ran in milliseconds, and JIT took 80-96% of its time
// (up to 3.4 s). No read planned above 1M. 10M keeps JIT for plans about
// 10x larger than the worst one today, where compiling may pay off.
const JIT_ABOVE_COST = 10_000_000;

// The role default applies to new connections of the app's role, so pooled
// connections pick it up when they reconnect. JIT_ABOVE_COST is the source
// of truth: a change to it moves the role default up or down.
async function setJitThreshold(
  sqlExecutor: JuniorSqlExecutor,
  io: UpgradeIo,
): Promise<void> {
  // A pooled session keeps the value it started with, so read the role
  // default first.
  const [row] = await sqlExecutor.query<{ cost: string }>(`
SELECT coalesce(
  (
    SELECT split_part(config, '=', 2)
    FROM pg_db_role_setting, unnest(setconfig) AS config
    WHERE setdatabase = 0
      AND setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND config LIKE 'jit_above_cost=%'
  ),
  current_setting('jit_above_cost')
) AS cost
`);
  if (Number(row?.cost) === JIT_ABOVE_COST) return;
  await sqlExecutor.query(
    `ALTER ROLE CURRENT_USER SET jit_above_cost = ${JIT_ABOVE_COST}`,
  );
  io.info(`Set jit_above_cost to ${JIT_ABOVE_COST} for the app's role.`);
}

/** Apply Junior and enabled-plugin database migrations. */
export async function runUpgrade(
  io: UpgradeIo = DEFAULT_IO,
  options: { pluginSet?: JuniorPluginSet | null | undefined } = {},
): Promise<void> {
  const { sql } = getChatConfig();
  const sqlExecutor: JuniorSqlExecutor = createJuniorSqlExecutor({
    connectionString: readMigrationDatabaseUrl(sql.databaseUrl),
    driver: sql.driver,
    onInfo: (message) => io.info(`    ${message}`),
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
