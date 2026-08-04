import type { JuniorSqlExecutor } from "./db";
import { createNeonJuniorSqlExecutor } from "./neon";
import { createPostgresJuniorSqlExecutor } from "./postgres";
import {
  DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
  type SqlDriver,
} from "@/chat/config";

/** Create the SQL executor appropriate for the configured database URL. */
export function createJuniorSqlExecutor(args: {
  connectionString: string;
  driver: SqlDriver;
  statementTimeoutMs?: number | false;
}): JuniorSqlExecutor {
  const statementTimeoutMs =
    args.statementTimeoutMs ?? DEFAULT_SQL_STATEMENT_TIMEOUT_MS;
  if (args.driver === "postgres") {
    return createPostgresJuniorSqlExecutor({
      connectionString: args.connectionString,
      statementTimeoutMs,
    });
  }
  return createNeonJuniorSqlExecutor({
    connectionString: args.connectionString,
    statementTimeoutMs,
  });
}
