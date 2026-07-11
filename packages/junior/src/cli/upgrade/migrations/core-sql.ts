import { getChatConfig } from "@/chat/config";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationContext, MigrationResult } from "../types";

/** Apply core SQL schema migrations before upgrade backfills run. */
export async function migrateCoreSqlSchema(
  _context: MigrationContext,
): Promise<MigrationResult> {
  const { sql } = getChatConfig();
  const executor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
  try {
    await migrateSchema(executor);
    return { existing: 0, migrated: 0, missing: 0, scanned: 0 };
  } finally {
    await executor.close();
  }
}

export const coreSqlSchemaMigration = {
  name: "core-sql-schema",
  run: migrateCoreSqlSchema,
};
