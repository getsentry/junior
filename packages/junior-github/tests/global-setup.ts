import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestProject } from "vitest/node";
import {
  assertLocalPostgresUrl,
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import pg from "pg";

declare module "vitest" {
  export interface ProvidedContext {
    githubPostgresHarness: PostgresHarnessConfig;
  }
}

// The Postgres from compose.yaml, like apps/example/.env.example.
const COMPOSE_DATABASE_URL = "postgres://junior:junior@localhost:54322/junior";
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");
// This backfill copies GitHub rows into core tables, which this package's
// tests do not create. Core depends on this package, so it cannot run core
// migrations here.
const CORE_TABLE_MIGRATION = "0008_native_code_backfill.sql";

async function migrate(connectionString: string): Promise<void> {
  const migrations = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql") && name !== CORE_TABLE_MIGRATION)
    .sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const migration of migrations) {
      await client.query(
        await readFile(resolve(MIGRATIONS_DIR, migration), "utf8"),
      );
    }
  } finally {
    await client.end();
  }
}

/** Migrate one template database that each Vitest worker copies. */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL ?? COMPOSE_DATABASE_URL;
  assertLocalPostgresUrl(databaseUrl);
  const config = await setupPostgresTemplate({
    applicationName: "junior-github-vitest",
    connectionString: databaseUrl,
    migrateTemplate: migrate,
  });
  project.provide("githubPostgresHarness", config);
  return async () => {
    await cleanupPostgresHarness(config);
  };
}
