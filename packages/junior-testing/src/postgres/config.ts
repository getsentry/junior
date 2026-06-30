import { randomUUID } from "node:crypto";
import { z } from "zod";

export const postgresHarnessConfigSchema = z
  .object({
    adminConnectionString: z.string().min(1),
    applicationName: z.string().min(1),
    databasePrefix: z.string().regex(/^[a-z][a-z0-9_]*$/),
    templateDatabaseName: z.string().regex(/^[a-z][a-z0-9_]*$/),
    templateConnectionString: z.string().min(1),
  })
  .strict();

export type PostgresHarnessConfig = z.output<
  typeof postgresHarnessConfigSchema
>;

export interface PostgresHarnessOptions {
  applicationName?: string;
  connectionString: string;
  databasePrefix?: string;
}

const DEFAULT_APPLICATION_NAME = "junior-vitest";

function safeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+/, "");
}

function databaseUrl(
  connectionString: string,
  databaseName: string,
  applicationName?: string,
): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) {
    parsed.searchParams.set("application_name", applicationName);
  }
  return parsed.toString();
}

/** Return a run-scoped Postgres test harness configuration. */
export function createPostgresHarnessConfig(
  options: PostgresHarnessOptions,
): PostgresHarnessConfig {
  const applicationName = options.applicationName ?? DEFAULT_APPLICATION_NAME;
  const prefix =
    options.databasePrefix ??
    `junior_test_${process.pid}_${safeToken(randomUUID()).slice(0, 8)}`;
  const databasePrefix = safeToken(prefix);
  if (!databasePrefix) {
    throw new Error("Postgres test database prefix is required");
  }
  const templateDatabaseName = `${databasePrefix}_template`;
  return {
    adminConnectionString: databaseUrl(
      options.connectionString,
      "postgres",
      applicationName,
    ),
    applicationName,
    databasePrefix,
    templateDatabaseName,
    templateConnectionString: databaseUrl(
      options.connectionString,
      templateDatabaseName,
      applicationName,
    ),
  };
}

/** Return a copy of a connection URL with a different database name. */
export function createPostgresDatabaseUrl(
  connectionString: string,
  databaseName: string,
): string {
  return databaseUrl(connectionString, databaseName);
}

/** Parse serialized Vitest worker config before using database privileges. */
export function parsePostgresHarnessConfig(
  value: unknown,
): PostgresHarnessConfig {
  return postgresHarnessConfigSchema.parse(value);
}
