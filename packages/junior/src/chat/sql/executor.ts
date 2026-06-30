import type { JuniorSqlExecutor } from "./db";
import { createNeonJuniorSqlExecutor } from "./neon";
import { createPostgresJuniorSqlExecutor } from "./postgres";
import type { SqlDriver } from "@/chat/config";

/** Create the SQL executor appropriate for the configured database URL. */
export function createJuniorSqlExecutor(args: {
  connectionString: string;
  driver: SqlDriver;
}): JuniorSqlExecutor {
  if (args.driver === "postgres") {
    return createPostgresJuniorSqlExecutor(args);
  }
  return createNeonJuniorSqlExecutor(args);
}
