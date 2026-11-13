import {
  createPostgresTestFixture,
  type PostgresTestFixture,
} from "@sentry/junior-testing/postgres/fixture";
import { drizzle } from "drizzle-orm/node-postgres";
import * as memorySqlSchema from "../src/db/schema";
import type { MemoryDb } from "../src/store";

export type MemoryFixture = PostgresTestFixture<MemoryDb>;

/** Connect to this worker's migrated memory database. */
export async function createMemoryFixture(): Promise<MemoryFixture> {
  return await createPostgresTestFixture((pool) =>
    drizzle(pool, { schema: memorySqlSchema }),
  );
}
