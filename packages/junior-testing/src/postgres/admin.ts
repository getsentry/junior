import pg from "pg";
import { createPostgresDatabaseUrl } from "./config";

const { Client } = pg;

export interface PostgresAdminOptions {
  adminConnectionString: string;
  applicationName: string;
}

function assertHarnessDatabaseName(databaseName: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe Postgres test database name: ${databaseName}`);
  }
}

function quotedIdentifier(databaseName: string): string {
  assertHarnessDatabaseName(databaseName);
  return `"${databaseName}"`;
}

async function withAdminClient<T>(
  options: PostgresAdminOptions,
  callback: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    application_name: options.applicationName,
    connectionString: options.adminConnectionString,
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

/** Terminate harness-owned connections to one test database. */
export async function terminatePostgresTestConnections(
  options: PostgresAdminOptions,
  databaseName: string,
): Promise<void> {
  assertHarnessDatabaseName(databaseName);
  await withAdminClient(options, async (client) => {
    await client.query(
      `
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = $1
  AND application_name = $2
  AND pid <> pg_backend_pid()
`,
      [databaseName, options.applicationName],
    );
  });
}

/** Drop a harness-owned test database if it exists. */
export async function dropPostgresTestDatabase(
  options: PostgresAdminOptions,
  databaseName: string,
): Promise<void> {
  await terminatePostgresTestConnections(options, databaseName);
  await withAdminClient(options, async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)}`,
    );
  });
}

/** Create an empty harness-owned test database. */
export async function createEmptyPostgresTestDatabase(
  options: PostgresAdminOptions,
  databaseName: string,
): Promise<string> {
  await dropPostgresTestDatabase(options, databaseName);
  await withAdminClient(options, async (client) => {
    await client.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  });
  return createPostgresDatabaseUrl(options.adminConnectionString, databaseName);
}

/** Create a harness-owned test database from a migrated template database. */
export async function createPostgresTestDatabaseFromTemplate(
  options: PostgresAdminOptions,
  databaseName: string,
  templateDatabaseName: string,
): Promise<string> {
  await dropPostgresTestDatabase(options, databaseName);
  await terminatePostgresTestConnections(options, templateDatabaseName);
  await withAdminClient(options, async (client) => {
    await client.query(
      `CREATE DATABASE ${quotedIdentifier(databaseName)} TEMPLATE ${quotedIdentifier(templateDatabaseName)}`,
    );
  });
  return createPostgresDatabaseUrl(options.adminConnectionString, databaseName);
}

/** Drop all harness-owned databases matching the run prefix. */
export async function cleanupPostgresTestDatabases(
  options: PostgresAdminOptions,
  databasePrefix: string,
): Promise<void> {
  assertHarnessDatabaseName(databasePrefix);
  const databaseNames = await withAdminClient(options, async (client) => {
    const result = await client.query<{ datname: string }>(
      `
SELECT datname
FROM pg_database
WHERE datname = $1
   OR starts_with(datname, $2)
ORDER BY datname DESC
`,
      [databasePrefix, `${databasePrefix}_`],
    );
    return result.rows.map((row) => row.datname);
  });
  for (const databaseName of databaseNames) {
    await dropPostgresTestDatabase(options, databaseName);
  }
}
