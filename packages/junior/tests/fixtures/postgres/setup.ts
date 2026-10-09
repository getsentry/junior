import { afterAll, beforeEach, inject } from "vitest";
import {
  cleanupPostgresWorkerDatabases,
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
  resetPostgresWorkerDatabase,
} from "@sentry/junior-testing/postgres";

const provided = inject("juniorPostgresHarness");
const harnessConfig = provided
  ? parsePostgresHarnessConfig(provided)
  : undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalJuniorDatabaseDriver = process.env.JUNIOR_DATABASE_DRIVER;

if (harnessConfig) {
  process.env.DATABASE_URL = await getPostgresWorkerDatabaseUrl(harnessConfig);
  process.env.JUNIOR_DATABASE_DRIVER = "postgres";
}

beforeEach(async () => {
  if (harnessConfig) {
    await resetPostgresWorkerDatabase(harnessConfig);
  }
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalJuniorDatabaseDriver === undefined) {
    delete process.env.JUNIOR_DATABASE_DRIVER;
  } else {
    process.env.JUNIOR_DATABASE_DRIVER = originalJuniorDatabaseDriver;
  }
  await cleanupPostgresWorkerDatabases();
});
