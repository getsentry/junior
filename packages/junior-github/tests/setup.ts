import {
  cleanupPostgresWorkerDatabases,
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
  resetPostgresTestDatabase,
} from "@sentry/junior-testing/postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";
import { mswServer, rejectUnhandledExternalRequest } from "./msw";

const resetPool = new pg.Pool({
  connectionString: await getPostgresWorkerDatabaseUrl(
    parsePostgresHarnessConfig(inject("githubPostgresHarness")),
  ),
  max: 1,
});

beforeAll(() => {
  mswServer.listen({
    onUnhandledRequest(request) {
      rejectUnhandledExternalRequest(request);
    },
  });
});

beforeEach(async () => {
  await resetPostgresTestDatabase(resetPool);
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(async () => {
  mswServer.close();
  await resetPool.end();
  await cleanupPostgresWorkerDatabases();
});
