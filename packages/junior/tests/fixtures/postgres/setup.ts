import { afterAll } from "vitest";
import { cleanupPostgresWorkerDatabases } from "@sentry/junior-testing/postgres";

afterAll(async () => {
  await cleanupPostgresWorkerDatabases();
});
