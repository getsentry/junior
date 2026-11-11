import type { TestProject } from "vitest/node";
import {
  assertLocalPostgresUrl,
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import pg from "pg";
import { githubTestMigrations, migrationSql } from "./github-db";

declare module "vitest" {
  export interface ProvidedContext {
    githubPostgresHarness: PostgresHarnessConfig;
  }
}

// The Postgres from compose.yaml, like apps/example/.env.example.
const COMPOSE_DATABASE_URL = "postgres://junior:junior@localhost:54322/junior";

/** Migrate one template database that each Vitest worker copies. */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL ?? COMPOSE_DATABASE_URL;
  assertLocalPostgresUrl(databaseUrl);
  const config = await setupPostgresTemplate({
    applicationName: "junior-github-vitest",
    connectionString: databaseUrl,
    migrateTemplate: async (connectionString) => {
      const client = new pg.Client({ connectionString });
      await client.connect();
      try {
        for (const migration of githubTestMigrations) {
          await client.query(await migrationSql(migration));
        }
      } finally {
        await client.end();
      }
    },
  });
  project.provide("githubPostgresHarness", config);
  return async () => {
    await cleanupPostgresHarness(config);
  };
}
