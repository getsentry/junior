// The SQL group: the database and how Junior talks to it.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { positiveInt, type Env } from "@/config/fields";

/** Default SQL statement timeout. */
export const DEFAULT_SQL_STATEMENT_TIMEOUT_MS = 30_000;

/** The database. No prefault: the database URL has no default. */
export const sqlSchema = z.strictObject({
  databaseUrl: z.string().trim().min(1),
  driver: z.enum(["neon", "postgres"]).optional(),
  statementTimeoutMs: z
    .union([positiveInt, z.literal(false)])
    .default(DEFAULT_SQL_STATEMENT_TIMEOUT_MS),
});

/** Env var that sets each SQL field, for error messages. */
export const sqlEnvNames: Record<string, string> = {
  "sql.databaseUrl": "DATABASE_URL",
  "sql.driver": "JUNIOR_DATABASE_DRIVER",
  "sql.statementTimeoutMs": "JUNIOR_SQL_STATEMENT_TIMEOUT_MS",
};

function parseSqlDriver(rawValue: string | undefined) {
  const value = toOptionalTrimmed(rawValue);
  if (value === undefined || value === "neon" || value === "postgres") {
    return value;
  }
  throw new Error("JUNIOR_DATABASE_DRIVER must be postgres or neon");
}

function parseSqlStatementTimeoutMs(
  rawValue: string | undefined,
): number | false | undefined {
  const trimmed = toOptionalTrimmed(rawValue);
  if (trimmed === undefined) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== trimmed) {
    throw new Error(
      "JUNIOR_SQL_STATEMENT_TIMEOUT_MS must be a non-negative integer",
    );
  }
  return value === 0 ? false : value;
}

/** Read the SQL group from env. */
export function readSqlEnv(env: Env): Partial<z.input<typeof sqlSchema>> {
  return {
    databaseUrl: toOptionalTrimmed(env["DATABASE_URL"]),
    driver: parseSqlDriver(env["JUNIOR_DATABASE_DRIVER"]),
    statementTimeoutMs: parseSqlStatementTimeoutMs(
      env["JUNIOR_SQL_STATEMENT_TIMEOUT_MS"],
    ),
  };
}

// A local database URL uses node-postgres. Any other URL uses Neon.
function defaultSqlDriver(databaseUrl: string): "neon" | "postgres" {
  try {
    const { hostname } = new URL(databaseUrl);
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
      ? "postgres"
      : "neon";
  } catch {
    return "neon";
  }
}

/** Default the driver from the database URL. */
export function deriveSql(sql: z.output<typeof sqlSchema>) {
  return {
    ...sql,
    driver: sql.driver ?? defaultSqlDriver(sql.databaseUrl),
  };
}
