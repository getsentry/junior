import { getChatConfig } from "@/chat/config";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createJuniorSqlExecutor } from "@/db/executor";
import { createJiti } from "jiti";
import type { MigrationContext, MigrationResult } from "../types";

const migrationLoader = createJiti(import.meta.url, { moduleCache: false });

/** Apply core schema and self-contained data migrations in journal order. */
export async function migrateCoreJournal(
  context: MigrationContext,
): Promise<MigrationResult> {
  const { sql } = getChatConfig();
  const executor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
  try {
    const result = await migrateSchema(executor, {
      getStateContext: context.getStateContext,
      loadTypeScript: async (path) =>
        await migrationLoader.import<Record<string, unknown>>(path),
      log: context.io.info,
      mode: "all",
    });
    return {
      existing: result.existing,
      migrated: result.migrated,
      missing: 0,
      scanned: result.scanned,
      skipped: result.skipped,
    };
  } finally {
    await executor.close();
  }
}
