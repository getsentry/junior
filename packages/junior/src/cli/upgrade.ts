import {
  disconnectStateAdapter,
  getConnectedStateContext,
} from "@/chat/state/adapter";
import { createJiti } from "jiti";
import { loadAppPluginSet } from "@/plugin-module";
import { sqlConversationMigration } from "./upgrade/migrations/conversations-sql";
import { coreSqlSchemaMigration } from "./upgrade/migrations/core-sql";
import { sqlConversationHistoryMigration } from "./upgrade/migrations/conversations-history-sql";
import { pluginStorageMigration } from "./upgrade/migrations/plugin-storage";
import { sqlPluginMigration } from "./upgrade/migrations/plugin-sql";
import { resolveUpgradePlugins } from "./upgrade/migrations/upgrade-plugins";
import { redisConversationStateMigration } from "./upgrade/migrations/redis-conversation-state";
import { agentTurnSessionActorMigration } from "./upgrade/migrations/agent-turn-session-actor";
import { conversationUsageRepairMigration } from "./upgrade/migrations/conversation-usage";
import type {
  MigrationContext,
  MigrationResult,
  UpgradeIo,
  UpgradeMigration,
} from "./upgrade/types";
import { type JuniorPluginSet } from "@/plugins";

const DEFAULT_IO: UpgradeIo = {
  info: console.log,
};
const localPluginLoader = createJiti(import.meta.url, { moduleCache: false });

const MIGRATIONS: UpgradeMigration[] = [
  agentTurnSessionActorMigration,
  redisConversationStateMigration,
  coreSqlSchemaMigration,
  sqlConversationMigration,
  sqlConversationHistoryMigration,
  conversationUsageRepairMigration,
  sqlPluginMigration,
  pluginStorageMigration,
];

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
  const plugins = await resolveUpgradePlugins(context);
  const migrationContext = { ...context, ...plugins };
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
export async function runUpgrade(
  io: UpgradeIo = DEFAULT_IO,
  options: { pluginSet?: JuniorPluginSet | null } = {},
): Promise<void> {
  try {
    const { redisStateAdapter, stateAdapter } =
      await getConnectedStateContext();
    const pluginSet =
      options.pluginSet === undefined
        ? await resolveUpgradePluginSet()
        : (options.pluginSet ?? undefined);
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
