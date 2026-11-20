import { inject } from "vitest";
import {
  parsePostgresHarnessConfig,
  type PostgresHarnessConfig,
} from "./config";
import { getPostgresWorkerDatabaseUrl } from "./transaction";

declare module "vitest" {
  export interface ProvidedContext {
    /** Files in `<package>/migrations` that the global setup does not apply. */
    postgresSkipMigrations?: string[];
    postgresTestHarness: PostgresHarnessConfig;
  }
}

/** Return the migrated database URL of the current Vitest worker. */
export async function getPostgresTestDatabaseUrl(): Promise<string> {
  return await getPostgresWorkerDatabaseUrl(
    parsePostgresHarnessConfig(inject("postgresTestHarness")),
  );
}
