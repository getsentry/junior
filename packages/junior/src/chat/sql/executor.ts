import type { JuniorSqlExecutor } from "./db";
import { createNeonJuniorSqlExecutor } from "./neon";
import { createPostgresJuniorSqlExecutor } from "./postgres";

function isLocalPostgresUrl(connectionString: string): boolean {
  const parsed = new URL(connectionString);
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1"
  );
}

/** Create the SQL executor appropriate for the configured database URL. */
export function createJuniorSqlExecutor(args: {
  connectionString: string;
}): JuniorSqlExecutor {
  if (isLocalPostgresUrl(args.connectionString)) {
    return createPostgresJuniorSqlExecutor(args);
  }
  return createNeonJuniorSqlExecutor(args);
}
