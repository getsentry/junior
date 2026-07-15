import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getStateAdapter } from "@/chat/state/adapter";
import { migrateConversationEventData } from "@/cli/upgrade/migrations/conversation-event-data";
import { migrateConversationVisibleMessageEvents } from "@/cli/upgrade/migrations/conversation-visible-message-events";
import type { JuniorSqlExecutor } from "@/db/db";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
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

  it("fails closed when visible-message rows remain unbackfilled", async () => {
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
      migrateConversationVisibleMessageEvents(
        { io: { info: () => {} }, stateAdapter: getStateAdapter() },
        { executor },
      ),
    ).rejects.toThrow("Visible-message event migration left 1 message row(s)");
  });

  it("advances visible-message batches by the last stable row key", async () => {
    const first = {
      conversation_id: "conversation-one",
      message_id: "m1",
      role: "user",
      text: "one",
      author_identity_id: null,
      meta: null,
      replied_at: null,
      created_at: "2026-07-14T10:00:01.000Z",
    } as const;
    const second = {
      ...first,
      conversation_id: "conversation-two",
      message_id: "m2",
      text: "two",
      created_at: "2026-07-14T10:00:02.000Z",
    } as const;
    const query = vi
      .fn<JuniorSqlExecutor["query"]>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    const executor = {
      query,
      withLock: async (_name: string, callback: () => Promise<unknown>) =>
        callback(),
    } as unknown as JuniorSqlExecutor;
    const append = vi.fn(async () => {});

    await expect(
      migrateConversationVisibleMessageEvents(
        { io: { info: () => {} }, stateAdapter: getStateAdapter() },
        { batchSize: 1, eventStore: { append }, executor },
      ),
    ).resolves.toMatchObject({ migrated: 2, missing: 0 });
    expect(query.mock.calls.map(([, parameters]) => parameters)).toEqual([
      [1, null, null, null],
      [1, first.conversation_id, first.created_at, first.message_id],
      [1, second.conversation_id, second.created_at, second.message_id],
      undefined,
    ]);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("backfills visible-message read-model rows after the hard cutover", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationsBeforeVisibleEvents = [
      "0000_initial.sql",
      "0001_conversation_metrics.sql",
      "0002_conversation_message_search.sql",
      "0003_peaceful_scalphunter.sql",
      "0004_conversation_events.sql",
    ].flatMap(migrationStatements);
    const visibleMessageEvents = migrationStatements(
      "0005_visible_message_events.sql",
    );
    const conversationId = "conversation-visible-events";

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationsBeforeVisibleEvents,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversations (
          conversation_id, created_at, last_activity_at, updated_at,
          execution_status
        ) VALUES ($1, $2, $2, $2, 'idle')`,
        [conversationId, new Date("2026-07-14T10:00:00.000Z")],
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversation_messages (
          conversation_id, message_id, role, text, meta, replied_at,
          created_at
        ) VALUES ($1, 'before', 'user', 'before backfill', $2::jsonb, $3, $4)`,
        [
          conversationId,
          JSON.stringify({ imagesHydrated: true }),
          new Date("2026-07-14T10:00:02.000Z"),
          new Date("2026-07-14T10:00:01.000Z"),
        ],
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        visibleMessageEvents,
      );

      const context = {
        io: { info: () => {} },
        stateAdapter: getStateAdapter(),
      };
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 1, missing: 0 });
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 0, missing: 0 });

      await fixture.sql.execute(
        `INSERT INTO junior_conversation_messages (
          conversation_id, message_id, role, text, created_at
        ) VALUES ($1, 'late', 'assistant', 'late read model', $2)`,
        [conversationId, new Date("2026-07-14T10:00:03.000Z")],
      );
      await fixture.sql.execute(
        `UPDATE junior_conversation_messages
         SET meta = $2::jsonb, replied_at = $3
         WHERE conversation_id = $1 AND message_id = 'late'`,
        [
          conversationId,
          JSON.stringify({ slackTs: "123.456" }),
          new Date("2026-07-14T10:00:04.000Z"),
        ],
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversation_messages (
          conversation_id, message_id, role, text, replied_at, created_at
        ) VALUES ($1, 'late-replied', 'user', 'already replied', $2, $3)`,
        [
          conversationId,
          new Date("2026-07-14T10:00:04.500Z"),
          new Date("2026-07-14T10:00:04.000Z"),
        ],
      );

      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 2, missing: 0 });

      const store = createSqlConversationMessageStore(fixture.sql);
      await store.record(conversationId, [
        {
          messageId: "application",
          role: "user",
          text: "new writer",
          meta: { imagesHydrated: false },
          createdAtMs: Date.parse("2026-07-14T10:00:05.000Z"),
        },
      ]);
      await store.record(conversationId, [
        {
          messageId: "application",
          role: "user",
          text: "new writer",
          meta: { imagesHydrated: true },
          createdAtMs: Date.parse("2026-07-14T10:00:05.000Z"),
        },
      ]);
      await store.markReplied(
        conversationId,
        "application",
        Date.parse("2026-07-14T10:00:06.000Z"),
      );

      const events = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(conversationId);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_recorded" &&
            event.data.messageId === "late",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_replied" &&
            event.data.messageId === "late-replied",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_metadata_updated" &&
            event.data.messageId === "late",
        ),
      ).toHaveLength(0);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_replied" &&
            event.data.messageId === "late",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_metadata_updated" &&
            event.data.messageId === "application",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.data.type === "visible_message_replied" &&
            event.data.messageId === "application",
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("renames history, preserves rows, and rewrites legacy event payloads", async () => {
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
          deleteFunction: string | null;
          insertFunction: string | null;
          relation: string | null;
          roleColumn: boolean;
        }>(
          `SELECT
            to_regclass('public.junior_agent_steps')::text AS relation,
            to_regprocedure('public.junior_agent_steps_insert_compat()')::text AS "insertFunction",
            to_regprocedure('public.junior_agent_steps_delete_compat()')::text AS "deleteFunction",
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'junior_conversation_events'
                AND column_name = 'role'
            ) AS "roleColumn"`,
        ),
      ).resolves.toEqual([
        {
          deleteFunction: null,
          insertFunction: null,
          relation: null,
          roleColumn: false,
        },
      ]);

      await expect(
        fixture.sql.query<{
          conversationId: string;
          contextEpoch: number;
          createdAtPreserved: boolean;
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
  type
FROM junior_conversation_events
ORDER BY seq
`),
      ).resolves.toEqual([
        {
          contextEpoch: 2,
          conversationId: "conversation-one",
          createdAtPreserved: true,
          schemaVersion: 1,
          seq: 1,
          type: "pi_message",
        },
        {
          contextEpoch: 3,
          conversationId: "conversation-one",
          createdAtPreserved: true,
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
