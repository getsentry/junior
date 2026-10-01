import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { MemoryDb } from "@/chat/memory/store";
import { juniorSqlSchema } from "@/db/schema";
import { pgliteJuniorExtensions, pgliteJuniorSqlExecutor } from "./sql";

export type MemorySqlFixture = LocalPgliteFixture<MemoryDb>;

/** Create an in-memory PGlite database with the migrated core schema. */
export async function createMemorySqlFixture(): Promise<MemorySqlFixture> {
  const fixture = await createLocalPgliteFixture<
    PgliteDatabase<typeof juniorSqlSchema>
  >(juniorSqlSchema, { extensions: pgliteJuniorExtensions });
  await migrateSchema(pgliteJuniorSqlExecutor(fixture));
  return fixture as MemorySqlFixture;
}
