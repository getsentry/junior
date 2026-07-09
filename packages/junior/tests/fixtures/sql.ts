import type { juniorConversations } from "@/db/schema";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { juniorSqlSchema } from "@/db/schema";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import {
  createEmptyJuniorSqlFixture,
  hasJuniorPostgresTestDatabase,
} from "./postgres/fixture";

export type JuniorSqlConversationInsert =
  typeof juniorConversations.$inferInsert;

export interface LocalJuniorSqlFixture {
  client?: LocalPgliteFixture<JuniorDatabase>["client"];
  sql: JuniorSqlExecutor;
  close(): Promise<void>;
}

/**
 * Create a local Postgres-compatible Junior SQL fixture for integration tests.
 */
export async function createLocalJuniorSqlFixture(): Promise<LocalJuniorSqlFixture> {
  if (hasJuniorPostgresTestDatabase()) {
    const fixture = await createEmptyJuniorSqlFixture();
    return {
      sql: fixture.sql,
      close: () => fixture.close(),
    };
  }

  const fixture =
    await createLocalPgliteFixture<JuniorDatabase>(juniorSqlSchema);

  return {
    client: fixture.client,
    sql: fixture as unknown as JuniorSqlExecutor,
    close: () => fixture.close(),
  };
}

/**
 * Build a conversation record row for tests that need scalable SQL fixtures.
 */
export function buildJuniorSqlConversation(
  overrides: Partial<JuniorSqlConversationInsert> = {},
): JuniorSqlConversationInsert {
  const now = new Date("2026-06-11T12:00:00.000Z");

  return {
    conversationId: "slack:C123:1718123456.000000",
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
