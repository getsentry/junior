import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { assertLocalPostgresUrl } from "./config";
import { cleanupPostgresHarness, setupPostgresTemplate } from "./template";

// The Postgres from compose.yaml, like apps/example/.env.example.
const COMPOSE_DATABASE_URL = "postgres://junior:junior@localhost:54322/junior";

async function applyMigrations(
  connectionString: string,
  migrationsDir: string,
  skip: ReadonlySet<string>,
): Promise<void> {
  const migrations = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql") && !skip.has(name))
    .sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const migration of migrations) {
      await client.query(
        await readFile(resolve(migrationsDir, migration), "utf8"),
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Vitest global setup for a package with SQL migrations. It applies every
 * file in `<package>/migrations` to one template database, except the files
 * in the `postgresSkipMigrations` provide value. Each worker copies the
 * template.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const databaseUrl = process.env["DATABASE_URL"] ?? COMPOSE_DATABASE_URL;
  assertLocalPostgresUrl(databaseUrl);
  const root = project.config.root;
  const skip = new Set(project.getProvidedContext().postgresSkipMigrations);
  const config = await setupPostgresTemplate({
    applicationName: `${basename(root)}-vitest`,
    connectionString: databaseUrl,
    migrateTemplate: (connectionString) =>
      applyMigrations(connectionString, resolve(root, "migrations"), skip),
  });
  project.provide("postgresTestHarness", config);
  return () => cleanupPostgresHarness(config);
}
