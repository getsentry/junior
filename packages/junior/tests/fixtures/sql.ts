import type { juniorConversations } from "@/db/schema";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { juniorSqlSchema } from "@/db/schema";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  createEmptyJuniorSqlFixture as createEmptyPostgresJuniorSqlFixture,
  createMigratedJuniorSqlFixture,
  type JuniorPostgresDatabaseFixture,
  hasJuniorPostgresTestDatabase as hasJuniorPostgresTestDatabaseFixture,
} from "./postgres/fixture";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
export type JuniorSqlConversationInsert =
  typeof juniorConversations.$inferInsert;

export interface LocalJuniorSqlFixture {
  client?: LocalPgliteFixture<JuniorDatabase>["client"];
  sql: JuniorSqlExecutor;
  close(): Promise<void>;
}

/** Return whether tests use the shared Postgres harness. */
export function hasJuniorPostgresTestDatabase(): boolean {
  return hasJuniorPostgresTestDatabaseFixture();
}

async function createPgliteJuniorSqlFixture(): Promise<LocalJuniorSqlFixture> {
  const fixture =
    await createLocalPgliteFixture<PgliteDatabase<typeof juniorSqlSchema>>(
      juniorSqlSchema,
    );
  const sql: JuniorSqlExecutor = {
    close: () => fixture.close(),
    db: () => fixture.db() as JuniorDatabase,
    execute: (statement, params) => fixture.execute(statement, params),
    migrate: (config) => migrate(fixture.db(), config),
    query: <T = unknown>(statement: string, params?: readonly unknown[]) =>
      fixture.query<T>(statement, params),
    transaction: (callback) => fixture.transaction(callback),
    withLock: (lockName, callback) => fixture.withLock(lockName, callback),
    withMigrationLock: (_migrationTable, callback) => callback(),
  };
  return {
    client: fixture.client,
    sql,
    close: () => fixture.close(),
  };
}

/** Create an isolated fixture with the current Junior schema. */
export async function createJuniorSqlFixture(): Promise<LocalJuniorSqlFixture> {
  if (hasJuniorPostgresTestDatabase()) {
    return await createMigratedJuniorSqlFixture();
  }
  const fixture = await createPgliteJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  return fixture;
}

/** Create an empty committed database for migration contract tests. */
export async function createEmptyJuniorSqlFixture(): Promise<LocalJuniorSqlFixture> {
  if (hasJuniorPostgresTestDatabase()) {
    return await createEmptyPostgresJuniorSqlFixture();
  }
  return await createPgliteJuniorSqlFixture();
}

/** Create an empty Postgres database for connection-level migration tests. */
export async function createEmptyJuniorPostgresFixture(): Promise<JuniorPostgresDatabaseFixture> {
  if (!hasJuniorPostgresTestDatabase()) {
    throw new Error("Postgres test database is required");
  }
  return await createEmptyPostgresJuniorSqlFixture();
}

/** Use the product-configured SQL connection for API boundary tests. */
export function createConfiguredJuniorSqlFixture(): LocalJuniorSqlFixture {
  return {
    sql: getSqlExecutor(),
    close: closeDb,
  };
}

/**
 * Build a conversation record row for tests that need scalable SQL fixtures.
 */
export function buildJuniorSqlConversation(
  overrides: Partial<JuniorSqlConversationInsert> = {},
): JuniorSqlConversationInsert {
  const now = new Date("2026-06-11T12:00:00.000Z");
  const conversationId =
    overrides.conversationId ?? "slack:C123:1718123456.000000";
  if (
    overrides.parentConversationId &&
    overrides.rootConversationId === undefined
  ) {
    throw new Error("Child conversation fixtures require rootConversationId");
  }

  return {
    conversationId,
    rootConversationId: conversationId,
    source: "slack",
    destination: {
      channelId: "C123",
      platform: "slack",
      teamId: "T123",
    },
    actor: {
      platform: "slack",
      slackUserId: "U123",
      teamId: "T123",
    },
    channelName: "eng-runtime",
    title: "Metadata migration test",
    createdAt: now,
    lastActivityAt: now,
    updatedAt: now,
    executionStatus: "idle",
    ...overrides,
  };
}
