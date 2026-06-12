import {
  disconnectStateAdapter,
  getConnectedStateContext,
} from "@/chat/state/adapter";
import {
  requireConversationSqlDatabaseUrl,
  sqlConversationMigration,
} from "./upgrade/migrations/conversations-sql";
import { redisConversationStateMigration } from "./upgrade/migrations/redis-conversation-state";
import type {
  MigrationContext,
  MigrationResult,
  UpgradeIo,
  UpgradeMigration,
} from "./upgrade/types";

const DEFAULT_IO: UpgradeIo = {
  info: console.log,
};

const MIGRATIONS: UpgradeMigration[] = [
  redisConversationStateMigration,
  sqlConversationMigration,
];

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
  requireConversationSqlDatabaseUrl(context);
  const results: MigrationResult[] = [];
  for (const migration of MIGRATIONS) {
    context.io.info(`Running migration ${migration.name}...`);
    const result = await migration.run(context);
    context.io.info(
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
    io.info("Running Junior upgrade migrations...");
    await runUpgradeMigrations({ io, redisStateAdapter, stateAdapter });
    io.info("Junior upgrade complete.");
  } finally {
    await disconnectStateAdapter();
  }
}
