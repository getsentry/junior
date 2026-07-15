import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getStateAdapter } from "@/chat/state/adapter";
import { migrateConversationEventData } from "@/cli/upgrade/migrations/conversation-event-data";
import type { JuniorSqlExecutor } from "@/db/db";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const migrationsFolder = path.resolve(
  import.meta.dirname,
  "../../../migrations",
);

function migrationStatements(name: string): string[] {
  return readFileSync(path.join(migrationsFolder, name), "utf8").split(
    "--> statement-breakpoint",
  );
}

async function executeStatements(
  execute: (statement: string) => Promise<void>,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    if (statement.trim()) {
      await execute(statement);
    }
  }
}

describe("conversation event migration", () => {
  it("advances batches by the last rewritten event key", async () => {
    const query = vi
      .fn<JuniorSqlExecutor["query"]>()
      .mockResolvedValueOnce([
        { conversation_id: "conversation-one", seq: 3 },
        { conversation_id: "conversation-two", seq: 1 },
      ])
      .mockResolvedValueOnce([{ conversation_id: "conversation-two", seq: 4 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    const executor = {
      query,
      withLock: async (_name: string, callback: () => Promise<unknown>) =>
        callback(),
    } as unknown as JuniorSqlExecutor;

    await expect(
      migrateConversationEventData(
        { io: { info: () => {} }, stateAdapter: getStateAdapter() },
        { batchSize: 2, executor },
      ),
    ).resolves.toEqual({
      existing: 0,
      migrated: 3,
      missing: 0,
      scanned: 3,
    });
    expect(query.mock.calls.map(([, parameters]) => parameters)).toEqual([
      [2, null, null],
      [2, "conversation-two", 1],
      [2, "conversation-two", 4],
      undefined,
    ]);
  });

  it("fails closed when skipped locked legacy rows remain", async () => {
    const query = vi
      .fn<JuniorSqlExecutor["query"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 1 }]);
    const executor = {
      query,
      withLock: async (_name: string, callback: () => Promise<unknown>) =>
        callback(),
    } as unknown as JuniorSqlExecutor;

    await expect(
      migrateConversationEventData(
        { io: { info: () => {} }, stateAdapter: getStateAdapter() },
        { batchSize: 10, executor },
      ),
    ).rejects.toThrow(
      "Conversation event migration left 1 locked legacy row(s)",
    );
  });

  it("fails closed when the remaining-row aggregate is missing", async () => {
    const query = vi
      .fn<JuniorSqlExecutor["query"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const executor = {
      query,
      withLock: async (_name: string, callback: () => Promise<unknown>) =>
        callback(),
    } as unknown as JuniorSqlExecutor;

    await expect(
      migrateConversationEventData(
        { io: { info: () => {} }, stateAdapter: getStateAdapter() },
        { executor },
      ),
    ).rejects.toThrow(
      "Conversation event migration could not verify that all legacy rows were rewritten",
    );
  });

  it("renames history, preserves rows, and provides rolling compatibility", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const initial = migrationStatements("0000_initial.sql");
    const conversationEvents = migrationStatements(
      "0004_conversation_events.sql",
    );

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        initial,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversations (
          conversation_id,
          created_at,
          last_activity_at,
          updated_at,
          execution_status
        ) VALUES ($1, $2, $2, $2, 'idle')`,
        ["conversation-one", new Date("2026-07-14T10:00:00.000Z")],
      );
      await fixture.sql.execute(
        `INSERT INTO junior_agent_steps (
          conversation_id,
          seq,
          context_epoch,
          type,
          role,
          payload,
          created_at
        ) VALUES
          ($1, 2, 3, 'authorization_completed', NULL, $2::jsonb, $4),
          ($1, 1, 2, 'pi_message', 'assistant', $3::jsonb, $4)`,
        [
          "conversation-one",
          JSON.stringify({ requestId: "request-one" }),
          JSON.stringify({
            schemaVersion: 7,
            message: {
              role: "assistant",
              schemaVersion: "message-owned",
            },
          }),
          new Date("2026-07-14T10:01:00.000Z"),
        ],
      );

      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        conversationEvents,
      );

      await expect(
        fixture.sql.query<{
          conversationId: string;
          contextEpoch: number;
          createdAtPreserved: boolean;
          role: string | null;
          schemaVersion: number;
          seq: number;
          type: string;
        }>(`
SELECT
  conversation_id AS "conversationId",
  seq,
  context_epoch AS "contextEpoch",
  created_at = '2026-07-14T10:01:00.000Z'::timestamptz AS "createdAtPreserved",
  schema_version AS "schemaVersion",
  type,
  role
FROM junior_conversation_events
ORDER BY seq
`),
      ).resolves.toEqual([
        {
          contextEpoch: 2,
          conversationId: "conversation-one",
          createdAtPreserved: true,
          role: "assistant",
          schemaVersion: 1,
          seq: 1,
          type: "pi_message",
        },
        {
          contextEpoch: 3,
          conversationId: "conversation-one",
          createdAtPreserved: true,
          role: null,
          schemaVersion: 1,
          seq: 2,
          type: "authorization_completed",
        },
      ]);

      await expect(
        migrateConversationEventData(
          { io: { info: () => {} }, stateAdapter: getStateAdapter() },
          { batchSize: 1, executor: fixture.sql },
        ),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        missing: 0,
        scanned: 1,
      });

      const canonicalRows = await fixture.sql.query<{
        payload: Record<string, unknown>;
        schemaVersion: number;
        seq: number;
        type: string;
      }>(`
SELECT
  seq,
  schema_version AS "schemaVersion",
  type,
  payload
FROM junior_conversation_events
ORDER BY seq
`);
      expect(canonicalRows).toEqual([
        {
          payload: {
            message: {
              role: "assistant",
              schemaVersion: "message-owned",
            },
          },
          schemaVersion: 1,
          seq: 1,
          type: "message",
        },
        {
          payload: { requestId: "request-one" },
          schemaVersion: 1,
          seq: 2,
          type: "authorization_completed",
        },
      ]);
      await expect(
        fixture.sql.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM junior_conversation_events
           WHERE type = 'pi_message'`,
        ),
      ).resolves.toEqual([{ count: 0 }]);
      await expect(
        fixture.sql.query<{ seq: number; type: string }>(
          `SELECT seq, type FROM junior_agent_steps ORDER BY seq`,
        ),
      ).resolves.toEqual([
        { seq: 1, type: "pi_message" },
        { seq: 2, type: "authorization_completed" },
      ]);

      await fixture.sql.execute(
        `INSERT INTO junior_agent_steps (
          conversation_id,
          seq,
          context_epoch,
          type,
          role,
          payload,
          created_at
        ) VALUES ($1, 3, 3, 'pi_message', 'user', $2::jsonb, $3)`,
        [
          "conversation-one",
          JSON.stringify({
            schemaVersion: 99,
            message: { role: "user", content: "hello" },
          }),
          new Date("2026-07-14T10:02:00.000Z"),
        ],
      );
      await expect(
        fixture.sql.query<{
          payload: Record<string, unknown>;
          schemaVersion: number;
          type: string;
        }>(
          `
SELECT
  schema_version AS "schemaVersion",
  type,
  payload
FROM junior_conversation_events
WHERE conversation_id = $1 AND seq = 3
`,
          ["conversation-one"],
        ),
      ).resolves.toEqual([
        {
          payload: { message: { role: "user", content: "hello" } },
          schemaVersion: 1,
          type: "message",
        },
      ]);

      await fixture.sql.execute(
        `DELETE FROM junior_agent_steps
         WHERE conversation_id = $1 AND seq = 3`,
        ["conversation-one"],
      );
      await expect(
        fixture.sql.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM junior_conversation_events
           WHERE conversation_id = $1 AND seq = 3`,
          ["conversation-one"],
        ),
      ).resolves.toEqual([{ count: 0 }]);

      await expect(
        migrateConversationEventData(
          { io: { info: () => {} }, stateAdapter: getStateAdapter() },
          { batchSize: 1, executor: fixture.sql },
        ),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 0,
      });
      await expect(
        fixture.sql.query<{ name: string; type: string }>(`
SELECT table_name AS name, table_type AS type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('junior_agent_steps', 'junior_conversation_events')
ORDER BY table_name
`),
      ).resolves.toEqual([
        { name: "junior_agent_steps", type: "VIEW" },
        { name: "junior_conversation_events", type: "BASE TABLE" },
      ]);
      await expect(
        fixture.sql.query<{ name: string }>(`
SELECT conname AS name
FROM pg_constraint
WHERE conrelid = 'junior_conversation_events'::regclass
ORDER BY conname
`),
      ).resolves.toEqual([
        {
          name: "junior_conversation_events_conversation_id_junior_conversations",
        },
        { name: "junior_conversation_events_conversation_id_seq_pk" },
      ]);
      await expect(
        fixture.sql.query<{ name: string }>(`
SELECT indexname AS name
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'junior_conversation_events'
ORDER BY indexname
`),
      ).resolves.toEqual([
        { name: "junior_conversation_events_conversation_id_seq_pk" },
        { name: "junior_conversation_events_epoch_idx" },
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
