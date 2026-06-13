import {
  disconnectStateAdapter,
  getConnectedStateContext,
} from "@/chat/state/adapter";
import {
  requireConversationSqlDatabaseUrl,
  sqlConversationMigration,
} from "./upgrade/migrations/conversations-sql";
import { pluginStorageMigration } from "./upgrade/migrations/plugin-storage";
import { sqlPluginMigration } from "./upgrade/migrations/plugin-sql";
import { redisConversationStateMigration } from "./upgrade/migrations/redis-conversation-state";
import type {
  MigrationContext,
  MigrationResult,
  UpgradeIo,
  UpgradeMigration,
} from "./upgrade/types";
import {
  pluginCatalogConfigFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";

const DEFAULT_IO: UpgradeIo = {
  info: console.log,
};

const MIGRATIONS: UpgradeMigration[] = [
  redisConversationStateMigration,
  sqlConversationMigration,
  sqlPluginMigration,
  pluginStorageMigration,
];

function isMissingVirtualConfig(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("#junior/config") ||
    error.message.includes("Cannot find module") ||
    error.message.includes("Failed to resolve import")
  );
}

async function resolveUpgradePluginSet(): Promise<JuniorPluginSet | undefined> {
  try {
    const mod: {
      pluginSet?: JuniorPluginSet;
    } = await import("#junior/config");
    return mod.pluginSet;
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    return undefined;
  }
}

function formatMigrationResult(result: MigrationResult): string {
  const fields = [
    `scanned=${result.scanned}`,
    `migrated=${result.migrated}`,
    `existing=${result.existing}`,
    `missing=${result.missing}`,
  ];
  if (result.skipped !== undefined) {
    fields.push(`skipped=${result.skipped}`);
  }
  return fields.join(" ");
}

/** Run all registered upgrade migrations in order. */
export async function runUpgradeMigrations(
  context: MigrationContext,
): Promise<MigrationResult[]> {
  const migrationContext =
    context.pluginSet && !context.pluginCatalogConfig
      ? {
          ...context,
          pluginCatalogConfig: pluginCatalogConfigFromPluginSet(
            context.pluginSet,
          ),
        }
      : context;
  requireConversationSqlDatabaseUrl(migrationContext);
  const results: MigrationResult[] = [];
  for (const migration of MIGRATIONS) {
    migrationContext.io.info(`Running migration ${migration.name}...`);
    const result = await migration.run(migrationContext);
    migrationContext.io.info(
      `Finished migration ${migration.name}: ${formatMigrationResult(result)}`,
    );
    results.push(result);
  }
  return results;
}

/** Run one-shot Junior upgrade migrations against the configured state store. */
export async function runUpgrade(io: UpgradeIo = DEFAULT_IO): Promise<void> {
  try {
    const { redisStateAdapter, stateAdapter } =
      await getConnectedStateContext();
    const pluginSet = await resolveUpgradePluginSet();
    io.info("Running Junior upgrade migrations...");
    await runUpgradeMigrations({
      io,
      pluginSet,
      redisStateAdapter,
      stateAdapter,
    });
    io.info("Junior upgrade complete.");
  } finally {
    await disconnectStateAdapter();
  }
}
