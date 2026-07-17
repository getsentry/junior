import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getStateAdapter } from "@/chat/state/adapter";
import { migrateConversationVisibleMessageEvents } from "@/cli/upgrade/migrations/conversation-visible-message-events";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { importConversationFromLegacy } from "@/cli/upgrade/migrations/conversation-history/import";
import type { SessionLogEntry } from "@/cli/upgrade/migrations/conversation-history/session-log";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const migrationsFolder = path.resolve(
  import.meta.dirname,
  "../../../migrations",
);

const historicalPreDrizzleEventDdl = [
  `CREATE TABLE junior_conversations (
    conversation_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    execution_status TEXT NOT NULL
  )`,
  `CREATE TABLE junior_agent_steps (
    conversation_id TEXT NOT NULL REFERENCES junior_conversations (conversation_id),
    seq INTEGER NOT NULL,
    context_epoch INTEGER NOT NULL,
    type TEXT NOT NULL,
    role TEXT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  )`,
  `CREATE INDEX junior_agent_steps_epoch_idx
    ON junior_agent_steps (conversation_id, context_epoch, seq)`,
] as const;

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
  it("imports external history before visible-message rows seal the conversation", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationsBeforeConversationEvents = [
      "0000_initial.sql",
      "0001_conversation_metrics.sql",
      "0002_conversation_message_search.sql",
      "0003_peaceful_scalphunter.sql",
    ].flatMap(migrationStatements);
    const conversationEvents = migrationStatements(
      "0004_conversation_events.sql",
    );
    const conversationId = "conversation-visible-events";

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationsBeforeConversationEvents,
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
        conversationEvents,
      );

      const eventStore = createSqlConversationEventStore(fixture.sql);
      await expect(eventStore.loadHistory(conversationId)).resolves.toEqual([]);

      const retainedSessionEntry = {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "retained-session",
        message: {
          role: "user",
          content: [{ type: "text", text: "retained external history" }],
          timestamp: Date.parse("2026-07-14T10:00:00.500Z"),
        },
      } as unknown as SessionLogEntry;
      await expect(
        importConversationFromLegacy(conversationId, {
          executor: fixture.sql,
          sessionLogStore: {
            read: async () => [
              retainedSessionEntry,
              {
                schemaVersion: 2,
                type: "pi_message",
                sessionId: "retained-session",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "later execution history" }],
                  timestamp: Date.parse("2026-07-14T10:00:03.000Z"),
                },
              } as unknown as SessionLogEntry,
            ],
          },
          loadVisibleMessages: async () => [],
        }),
      ).resolves.toEqual({ imported: true });

      const context = {
        io: { info: () => {} },
        stateAdapter: getStateAdapter(),
      };
      await context.stateAdapter.connect();
      const turnSessionIndex = `junior:agent_turn_session:conversation:${conversationId}:index`;
      const activeSessionKey = `junior:agent_turn_session:${conversationId}:active-turn`;
      await context.stateAdapter.appendToList(turnSessionIndex, {
        conversationId,
        sessionId: "active-turn",
        state: "running",
      });
      await context.stateAdapter.set(activeSessionKey, {
        conversationId,
        sessionId: "active-turn",
        state: "running",
        committedSeq: 1,
        turnStartSeq: 0,
      });
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).rejects.toThrow("unfinished turn session");
      await context.stateAdapter.set(activeSessionKey, {
        conversationId,
        sessionId: "active-turn",
        state: "completed",
        committedSeq: 1,
        turnStartSeq: 0,
      });
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 1, missing: 0 });
      await expect(
        context.stateAdapter.get(activeSessionKey),
      ).resolves.toBeNull();
      const staleSessionKey = `junior:agent_turn_session:${conversationId}:stale-terminal`;
      await context.stateAdapter.appendToList(turnSessionIndex, {
        conversationId,
        sessionId: "stale-terminal",
        state: "failed",
      });
      await context.stateAdapter.set(staleSessionKey, {
        conversationId,
        sessionId: "stale-terminal",
        state: "failed",
        committedSeq: 3,
      });
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 0, missing: 0 });
      await expect(
        context.stateAdapter.get(staleSessionKey),
      ).resolves.toBeNull();
      const events = await eventStore.loadHistory(conversationId);
      expect(
        events.map((event) => ({
          contextEpoch: event.contextEpoch,
          idempotencyKey: event.idempotencyKey,
          messageId:
            "messageId" in event.data ? event.data.messageId : undefined,
          seq: event.seq,
          type: event.data.type,
        })),
      ).toEqual([
        {
          contextEpoch: 0,
          idempotencyKey: undefined,
          messageId: undefined,
          seq: 0,
          type: "message",
        },
        {
          contextEpoch: 0,
          idempotencyKey: "visible-message:before:recorded",
          messageId: "before",
          seq: 1,
          type: "visible_message_recorded",
        },
        {
          contextEpoch: 0,
          idempotencyKey: "visible-message:before:replied",
          messageId: "before",
          seq: 2,
          type: "visible_message_replied",
        },
        {
          contextEpoch: 0,
          idempotencyKey: undefined,
          messageId: undefined,
          seq: 3,
          type: "message",
        },
      ]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("renames history, preserves rows, and rewrites legacy event payloads", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const conversationEvents = migrationStatements(
      "0004_conversation_events.sql",
    );

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        historicalPreDrizzleEventDdl,
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
          ($1, 1, 2, 'pi_message', 'assistant', $3::jsonb, $4),
          ($1, 3, 3, 'subagent_started', NULL, $5::jsonb, $4)`,
        [
          "conversation-one",
          JSON.stringify({
            kind: "mcp",
            provider: "github",
            actorId: "U1",
            authorizationId: "authorization-one",
          }),
          JSON.stringify({
            schemaVersion: 7,
            message: {
              role: "assistant",
              schemaVersion: "message-owned",
            },
          }),
          new Date("2026-07-14T10:01:00.000Z"),
          JSON.stringify({
            subagentInvocationId: "subagent-one",
            subagentKind: "advisor",
            childConversationId: "advisor:conversation-one",
            historyMode: "shared",
          }),
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
          createdAt: Date;
          idempotencyKey: string | null;
          payload: Record<string, unknown>;
          schemaVersion: number;
          seq: number;
          type: string;
        }>(`
SELECT
  conversation_id AS "conversationId",
  seq,
  context_epoch AS "contextEpoch",
  schema_version AS "schemaVersion",
  idempotency_key AS "idempotencyKey",
  type,
  payload,
  created_at AS "createdAt"
FROM junior_conversation_events
ORDER BY seq
`),
      ).resolves.toEqual([
        {
          contextEpoch: 2,
          conversationId: "conversation-one",
          createdAt: new Date("2026-07-14T10:01:00.000Z"),
          idempotencyKey: null,
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
          contextEpoch: 3,
          conversationId: "conversation-one",
          createdAt: new Date("2026-07-14T10:01:00.000Z"),
          idempotencyKey: null,
          payload: {
            kind: "mcp",
            provider: "github",
            actorId: "U1",
            authorizationId: "authorization-one",
          },
          schemaVersion: 1,
          seq: 2,
          type: "authorization_completed",
        },
        {
          contextEpoch: 3,
          conversationId: "conversation-one",
          createdAt: new Date("2026-07-14T10:01:00.000Z"),
          idempotencyKey: null,
          payload: {
            childConversationId: "advisor:conversation-one",
            subagentInvocationId: "subagent-one",
            subagentKind: "advisor",
          },
          schemaVersion: 1,
          seq: 3,
          type: "subagent_started",
        },
      ]);
      const decoded = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory("conversation-one");
      expect(decoded.map((event) => event.data.type)).toEqual([
        "message",
        "authorization_completed",
        "subagent_started",
      ]);
      expect(decoded[2]?.data).toEqual({
        type: "subagent_started",
        subagentInvocationId: "subagent-one",
        subagentKind: "advisor",
        childConversationId: "advisor:conversation-one",
      });
      await expect(
        fixture.sql.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM junior_conversation_events
           WHERE type = 'pi_message'`,
        ),
      ).resolves.toEqual([{ count: 0 }]);
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
        { name: "junior_conversation_events_idempotency_idx" },
        { name: "junior_conversation_events_type_idx" },
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
