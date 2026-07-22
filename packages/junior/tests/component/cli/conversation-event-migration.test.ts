import path from "node:path";
import { readFileSync } from "node:fs";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { describe, expect, it } from "vitest";
import { getChatConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";
import { migrateConversationVisibleMessageEvents } from "@/cli/upgrade/migrations/conversation-visible-message-events";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { importConversationFromLegacy } from "@/cli/upgrade/migrations/conversation-history/import";
import { normalizeConversationContextCheckpoints } from "@/cli/upgrade/migrations/conversation-context-checkpoints";
import { prepareConversationEventResequence } from "@/cli/upgrade/migrations/conversation-event-cursors";
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
  it("fails closed when a discovered turn cursor is malformed", async () => {
    const conversationId = "conversation-malformed-cursor";
    const statePrefix = getChatConfig().state.keyPrefix;
    const rawKey = [
      "chat-sdk:cache",
      ...(statePrefix ? [statePrefix] : []),
      `junior:agent_turn_session:${conversationId}:turn-1`,
    ].join(":");
    const context = {
      io: { info: () => {} },
      redisStateAdapter: {
        getClient: () => ({
          sendCommand: async (args: readonly string[]) =>
            args[0] === "SCAN" ? ["0", [rawKey]] : "{malformed",
        }),
      } as unknown as RedisStateAdapter,
      stateAdapter: getStateAdapter(),
    };

    await expect(
      prepareConversationEventResequence(context, new Set([conversationId])),
    ).rejects.toThrow(`Turn-session cursor ${rawKey} is invalid JSON`);
  });

  it("fails closed when a discovered turn cursor identity mismatches its key", async () => {
    const conversationId = "conversation-mismatched-cursor";
    const statePrefix = getChatConfig().state.keyPrefix;
    const rawKey = [
      "chat-sdk:cache",
      ...(statePrefix ? [statePrefix] : []),
      `junior:agent_turn_session:${conversationId}:turn-1`,
    ].join(":");
    const context = {
      io: { info: () => {} },
      redisStateAdapter: {
        getClient: () => ({
          sendCommand: async (args: readonly string[]) =>
            args[0] === "SCAN"
              ? ["0", [rawKey]]
              : JSON.stringify({
                  conversationId: "different-conversation",
                  sessionId: "turn-1",
                }),
        }),
      } as unknown as RedisStateAdapter,
      stateAdapter: getStateAdapter(),
    };

    await expect(
      prepareConversationEventResequence(context, new Set([conversationId])),
    ).rejects.toThrow(
      `Turn-session cursor ${rawKey} identity does not match its key`,
    );
  });

  it("ignores malformed raw cursors for conversations outside the resequence", async () => {
    const conversationId = "conversation-being-resequenced";
    const statePrefix = getChatConfig().state.keyPrefix;
    const unrelatedRawKey = [
      "chat-sdk:cache",
      ...(statePrefix ? [statePrefix] : []),
      "junior:agent_turn_session:unrelated-conversation:turn-1",
    ].join(":");
    const context = {
      io: { info: () => {} },
      redisStateAdapter: {
        getClient: () => ({
          sendCommand: async (args: readonly string[]) => {
            if (args[0] === "SCAN") return ["0", [unrelatedRawKey]];
            throw new Error(`Unexpected Redis command ${args.join(" ")}`);
          },
        }),
      } as unknown as RedisStateAdapter,
      stateAdapter: getStateAdapter(),
    };

    await expect(
      prepareConversationEventResequence(context, new Set([conversationId])),
    ).resolves.toBeUndefined();
  });

  it("preserves the live suffix and full count from deployed compaction rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationsBeforeConversationEvents = [
      "0000_initial.sql",
      "0001_conversation_metrics.sql",
      "0002_conversation_message_search.sql",
      "0003_peaceful_scalphunter.sql",
      "0004_useful_magus.sql",
    ].flatMap(migrationStatements);
    const conversationId = "conversation-compacted-upgrade";

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
          conversation_id, message_id, role, text, created_at
        )
        SELECT
          $1,
          'covered-' || lpad(position::text, 3, '0'),
          'user',
          'must stay compacted',
          $2::timestamptz + position * interval '1 second'
        FROM generate_series(0, 500) position
        UNION ALL
        SELECT $1, 'live', 'user', 'must remain live', $3`,
        [
          conversationId,
          new Date("2026-07-14T10:00:01.000Z"),
          new Date("2026-07-14T10:10:01.000Z"),
        ],
      );
      await fixture.sql.execute(
        `INSERT INTO junior_agent_steps (
          conversation_id, seq, context_epoch, type, role, payload, created_at
        ) VALUES ($1, 0, 0, 'messages_summarized', NULL, $2::jsonb, $3)`,
        [
          conversationId,
          JSON.stringify({
            compactions: [
              {
                id: "legacy-compaction",
                summary: "501 earlier messages",
                createdAtMs: Date.parse("2026-07-14T10:09:11.000Z"),
                coveredMessageIds: Array.from(
                  { length: 500 },
                  (_, index) => `covered-${index.toString().padStart(3, "0")}`,
                ),
              },
            ],
          }),
          new Date("2026-07-14T10:09:11.000Z"),
        ],
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0005_conversation_events.sql"),
      );

      await expect(
        fixture.sql.query<{ coveredIds: number }>(
          `SELECT jsonb_array_length(
             payload->'compactions'->0->'coveredMessageIds'
           )::integer AS "coveredIds"
           FROM junior_conversation_events
           WHERE conversation_id = $1
             AND type = 'messages_summarized'`,
          [conversationId],
        ),
      ).resolves.toEqual([{ coveredIds: 500 }]);

      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      await stateAdapter.set(`thread-state:${conversationId}`, {
        conversation: {
          compactions: [
            {
              id: "legacy-compaction",
              summary: "501 earlier messages",
              createdAtMs: Date.parse("2026-07-14T10:09:11.000Z"),
              coveredMessageIds: Array.from(
                { length: 500 },
                (_, index) => `covered-${index.toString().padStart(3, "0")}`,
              ),
            },
          ],
          messages: [
            {
              id: "live",
              role: "user",
              text: "must remain live",
              createdAtMs: Date.parse("2026-07-14T10:10:01.000Z"),
            },
          ],
          stats: { compactedMessageCount: 501 },
        },
      });

      await expect(
        migrateConversationVisibleMessageEvents(
          { io: { info: () => {} }, stateAdapter },
          { batchSize: 73, executor: fixture.sql },
        ),
      ).resolves.toMatchObject({ migrated: 502, missing: 0 });

      const store = createSqlConversationEventStore(fixture.sql);
      const visible = await store.loadMessageHistory(conversationId);
      expect(visible.compaction?.data).toEqual({
        type: "messages_summarized",
        historyFromSeq: 502,
        compactions: [
          {
            id: "legacy-compaction",
            summary: "501 earlier messages",
            createdAtMs: Date.parse("2026-07-14T10:09:11.000Z"),
            coveredMessageCount: 501,
          },
        ],
      });
      expect(visible.events.map((event) => event.seq)).toEqual([502]);
      expect(
        projectConversationMessages(visible.events, {
          historyFromSeq: 502,
        }).map((message) => message.id),
      ).toEqual(["live"]);
      expect(
        JSON.stringify(await store.loadHistory(conversationId)),
      ).not.toContain("coveredMessageIds");
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("imports external history before visible-message rows seal the conversation", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationsBeforeConversationEvents = [
      "0000_initial.sql",
      "0001_conversation_metrics.sql",
      "0002_conversation_message_search.sql",
      "0003_peaceful_scalphunter.sql",
      "0004_useful_magus.sql",
    ].flatMap(migrationStatements);
    const conversationEvents = migrationStatements(
      "0005_conversation_events.sql",
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
          modelId: "test/standard",
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

      const turnSessionIndex = `junior:agent_turn_session:conversation:${conversationId}:index`;
      const activeSessionKey = `junior:agent_turn_session:${conversationId}:active-turn`;
      const statePrefix = getChatConfig().state.keyPrefix;
      const rawActiveSessionKey = [
        "chat-sdk:cache",
        ...(statePrefix ? [statePrefix] : []),
        activeSessionKey,
      ].join(":");
      const redisCommands: string[][] = [];
      const redisStateAdapter = {
        getClient: () => ({
          sendCommand: async (args: readonly string[]) => {
            redisCommands.push([...args]);
            if (args[0] === "SCAN") {
              return ["0", [rawActiveSessionKey]];
            }
            if (args[0] === "GET" && args[1] === rawActiveSessionKey) {
              return JSON.stringify({
                conversationId,
                sessionId: "active-turn",
              });
            }
            throw new Error(`Unexpected Redis command ${args.join(" ")}`);
          },
        }),
      } as unknown as RedisStateAdapter;
      const context = {
        io: { info: () => {} },
        redisStateAdapter,
        stateAdapter: getStateAdapter(),
      };
      await context.stateAdapter.connect();
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
      expect(redisCommands.slice(0, 2)).toEqual([
        [
          "SCAN",
          "0",
          "MATCH",
          `*:cache:${statePrefix ? `${statePrefix}:` : ""}junior:agent_turn_session:*`,
          "COUNT",
          "500",
        ],
        ["GET", rawActiveSessionKey],
      ]);
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
      const rerunSessionKey = `junior:agent_turn_session:${conversationId}:rerun-active`;
      await context.stateAdapter.appendToList(turnSessionIndex, {
        conversationId,
        sessionId: "rerun-active",
        state: "running",
      });
      await context.stateAdapter.set(rerunSessionKey, {
        conversationId,
        sessionId: "rerun-active",
        state: "running",
        committedSeq: 3,
      });
      const redisCommandCountBeforeRerun = redisCommands.length;
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 0, missing: 0 });
      await expect(
        context.stateAdapter.get(rerunSessionKey),
      ).resolves.toMatchObject({ state: "running", committedSeq: 3 });
      expect(redisCommands).toHaveLength(redisCommandCountBeforeRerun);
      await context.stateAdapter.set(rerunSessionKey, {
        conversationId,
        sessionId: "rerun-active",
        state: "completed",
        committedSeq: 3,
      });
      await fixture.sql.execute(
        `INSERT INTO junior_conversation_messages (
          conversation_id, message_id, role, text, created_at
        ) VALUES ($1, 'deployment-tail', 'assistant', 'recover me', $2)`,
        [conversationId, new Date("2026-07-14T10:00:04.000Z")],
      );
      await expect(
        migrateConversationVisibleMessageEvents(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 1, missing: 0 });
      await expect(
        context.stateAdapter.get(rerunSessionKey),
      ).resolves.toBeNull();
      const events = await eventStore.loadHistory(conversationId);
      expect(
        events.map((event) => ({
          historyVersion: event.historyVersion,
          idempotencyKey: event.idempotencyKey,
          messageId:
            "messageId" in event.data ? event.data.messageId : undefined,
          seq: event.seq,
          type: event.data.type,
        })),
      ).toEqual([
        {
          historyVersion: 0,
          idempotencyKey: undefined,
          messageId: undefined,
          seq: 0,
          type: "agent_step",
        },
        {
          historyVersion: 0,
          idempotencyKey: "message:before",
          messageId: "before",
          seq: 1,
          type: "message",
        },
        {
          historyVersion: 0,
          idempotencyKey: "message:before:handled",
          messageId: "before",
          seq: 2,
          type: "message_handled",
        },
        {
          historyVersion: 0,
          idempotencyKey: undefined,
          messageId: undefined,
          seq: 3,
          type: "agent_step",
        },
        {
          historyVersion: 0,
          idempotencyKey: "message:deployment-tail",
          messageId: "deployment-tail",
          seq: 4,
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
      "0005_conversation_events.sql",
    );

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        historicalPreDrizzleEventDdl,
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0004_useful_magus.sql"),
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
          ($1, 3, 3, 'subagent_started', NULL, $5::jsonb, $4),
          ($1, 4, 3, 'tool_execution_started', NULL, $6::jsonb, $4)`,
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
          JSON.stringify({
            toolCallId: "tool-call-one",
            toolName: "search",
            args: { token: "legacy-sensitive-token" },
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
          historyVersion: number;
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
  history_version AS "historyVersion",
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
          historyVersion: 2,
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
          type: "agent_step",
        },
        {
          historyVersion: 3,
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
          historyVersion: 3,
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
        {
          historyVersion: 3,
          conversationId: "conversation-one",
          createdAt: new Date("2026-07-14T10:01:00.000Z"),
          idempotencyKey: null,
          payload: {
            toolCallId: "tool-call-one",
            toolName: "search",
          },
          schemaVersion: 1,
          seq: 4,
          type: "tool_execution_started",
        },
      ]);
      const decoded = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory("conversation-one");
      expect(decoded.map((event) => event.data.type)).toEqual([
        "agent_step",
        "authorization_completed",
        "subagent_started",
        "tool_execution_started",
      ]);
      expect(decoded[2]?.data).toEqual({
        type: "subagent_started",
        subagentInvocationId: "subagent-one",
        subagentKind: "advisor",
        childConversationId: "advisor:conversation-one",
      });
      expect(decoded[3]?.data).toEqual({
        type: "tool_execution_started",
        toolCallId: "tool-call-one",
        toolName: "search",
      });
      expect(JSON.stringify(decoded)).not.toContain("legacy-sensitive-token");
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
        { name: "junior_conversation_events_history_version_idx" },
        { name: "junior_conversation_events_idempotency_idx" },
        { name: "junior_conversation_events_message_search_idx" },
        { name: "junior_conversation_events_type_idx" },
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("converts covered visible-message ids to a suffix boundary", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        historicalPreDrizzleEventDdl,
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0004_useful_magus.sql"),
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversations (
          conversation_id, created_at, last_activity_at, updated_at,
          execution_status
        ) VALUES ($1, $2, $2, $2, 'idle')`,
        ["conversation-compacted", new Date("2026-07-14T10:00:00.000Z")],
      );
      await fixture.sql.execute(
        `INSERT INTO junior_agent_steps (
          conversation_id, seq, context_epoch, type, role, payload, created_at
        ) VALUES
          ($1, 0, 0, 'message', NULL, $2::jsonb, $5),
          ($1, 1, 0, 'message', NULL, $3::jsonb, $5),
          ($1, 2, 0, 'messages_summarized', NULL, $4::jsonb, $5)`,
        [
          "conversation-compacted",
          JSON.stringify({ messageId: "covered", role: "user", text: "old" }),
          JSON.stringify({ messageId: "live", role: "user", text: "new" }),
          JSON.stringify({
            compactions: [
              {
                id: "compaction-1",
                summary: "old summary",
                createdAtMs: 1_000,
                coveredMessageIds: ["covered"],
              },
            ],
          }),
          new Date("2026-07-14T10:01:00.000Z"),
        ],
      );

      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0005_conversation_events.sql"),
      );

      const store = createSqlConversationEventStore(fixture.sql);
      const history = await store.loadMessageHistory("conversation-compacted");
      expect(history.events.map((event) => event.seq)).toEqual([1]);
      expect(history.compaction?.data).toEqual({
        type: "messages_summarized",
        historyFromSeq: 1,
        compactions: [
          {
            id: "compaction-1",
            summary: "old summary",
            createdAtMs: 1_000,
            coveredMessageCount: 1,
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("moves deployed context copies onto canonical checkpoint markers", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const conversationId = "conversation-context-checkpoints";
    const user = {
      role: "user",
      content: [
        {
          type: "text",
          text: "keep this quote: Context handoff summary for future Junior turns:",
        },
      ],
    };
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
    };
    const compactionSummary = {
      role: "user",
      content: [
        {
          type: "text",
          text: "Context handoff summary for future Junior turns:\nsummary",
        },
      ],
    };
    const normalizedCompactionSummary = {
      role: "user",
      content: [
        {
          type: "text",
          text: "Context compaction summary for future Junior turns:\nsummary",
        },
      ],
    };
    const handoffSummary = {
      role: "user",
      content: [
        {
          type: "text",
          text: "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:\ncontinue",
        },
      ],
    };
    const handoffAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "implemented" }],
    };
    const bot = {
      embeddingModelId: "test/embedding",
      fastModelId: "test/fast",
      loadingMessages: [],
      profiles: {
        standard: { modelId: "test/standard" },
        handoff: { modelId: "test/handoff", reasoningLevel: "xhigh" as const },
      },
      maxSlicesPerTurn: 1,
      turnTimeoutMs: 1,
      userName: "Junior",
    };

    try {
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        historicalPreDrizzleEventDdl,
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0004_useful_magus.sql"),
      );
      await fixture.sql.execute(
        `INSERT INTO junior_conversations (
          conversation_id, created_at, last_activity_at, updated_at,
          execution_status
        ) VALUES ($1, $2, $2, $2, 'idle')`,
        [conversationId, new Date("2026-07-14T10:00:00.000Z")],
      );
      await executeStatements(
        (statement) => fixture.sql.execute(statement),
        migrationStatements("0005_conversation_events.sql"),
      );
      const at = new Date("2026-07-14T10:01:00.000Z");
      const rows: Array<[number, number, string, Record<string, unknown>]> = [
        [0, 0, "agent_step", { message: user }],
        [1, 0, "agent_step", { message: firstAssistant }],
        [2, 1, "context_epoch_started", { reason: "compaction" }],
        [3, 1, "agent_step", { message: user }],
        [4, 1, "agent_step", { message: compactionSummary }],
        [
          5,
          1,
          "agent_step",
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "after compaction" }],
            },
          },
        ],
        [
          6,
          1,
          "tool_execution_started",
          { toolCallId: "handoff-call", toolName: "handoff" },
        ],
        [
          7,
          2,
          "context_epoch_started",
          {
            reason: "handoff",
            modelProfile: "handoff",
            modelId: "test/handoff",
          },
        ],
        [8, 2, "agent_step", { message: handoffSummary }],
        [9, 2, "agent_step", { message: handoffAssistant }],
        [
          10,
          3,
          "context_epoch_started",
          {
            reason: "rollback",
            modelProfile: "handoff",
            modelId: "test/handoff",
          },
        ],
        [11, 3, "agent_step", { message: handoffSummary }],
        [12, 3, "agent_step", { message: handoffAssistant }],
        [
          13,
          3,
          "agent_step",
          {
            message: {
              role: "user",
              content: [{ type: "text", text: "changed suffix" }],
            },
          },
        ],
        [
          14,
          3,
          "messages_summarized",
          {
            historyFromSeq: 13,
            compactions: [
              {
                id: "visible-compaction",
                summary: "older visible messages",
                createdAtMs: at.getTime(),
                coveredMessageCount: 1,
              },
            ],
          },
        ],
      ];
      for (const [seq, historyVersion, type, payload] of rows) {
        await fixture.sql.execute(
          `INSERT INTO junior_conversation_events (
            conversation_id, seq, history_version, schema_version, type,
            payload, created_at
          ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6)`,
          [
            conversationId,
            seq,
            historyVersion,
            type,
            JSON.stringify(payload),
            at,
          ],
        );
      }

      const context = {
        io: { info: () => {} },
        stateAdapter: getStateAdapter(),
      };
      await context.stateAdapter.connect();
      const sessionId = "checkpoint-upgrade-turn";
      const sessionKey = `junior:agent_turn_session:${conversationId}:${sessionId}`;
      await context.stateAdapter.appendToList(
        `junior:agent_turn_session:conversation:${conversationId}:index`,
        { conversationId, sessionId, state: "running" },
      );
      await context.stateAdapter.set(sessionKey, {
        conversationId,
        sessionId,
        state: "running",
        committedSeq: 13,
        turnStartSeq: 10,
      });
      await expect(
        normalizeConversationContextCheckpoints(context, {
          executor: fixture.sql,
          bot,
        }),
      ).rejects.toThrow("unfinished turn session");
      await context.stateAdapter.set(sessionKey, {
        conversationId,
        sessionId,
        state: "completed",
        committedSeq: 13,
        turnStartSeq: 10,
      });
      await fixture.sql.execute(
        `UPDATE junior_conversation_events
         SET payload = jsonb_set(payload, '{modelProfile}', $3::jsonb)
         WHERE conversation_id = $1 AND seq = $2`,
        [conversationId, 7, JSON.stringify("standard")],
      );
      await expect(
        normalizeConversationContextCheckpoints(context, {
          executor: fixture.sql,
          bot,
        }),
      ).rejects.toThrow("handoff profile must not be standard");
      await expect(
        fixture.sql.query<{ seq: number }>(
          `SELECT seq
           FROM junior_conversation_events
           WHERE conversation_id = $1
           ORDER BY seq`,
          [conversationId],
        ),
      ).resolves.toEqual(Array.from({ length: 15 }, (_, seq) => ({ seq })));
      await fixture.sql.execute(
        `UPDATE junior_conversation_events
         SET payload = jsonb_set(payload, '{modelProfile}', $3::jsonb)
         WHERE conversation_id = $1 AND seq = $2`,
        [conversationId, 7, JSON.stringify("handoff")],
      );
      await expect(
        normalizeConversationContextCheckpoints(context, {
          executor: fixture.sql,
          bot,
        }),
      ).resolves.toMatchObject({ migrated: 3, scanned: 1 });
      await expect(context.stateAdapter.get(sessionKey)).resolves.toBeNull();

      const history = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(conversationId);
      expect(history.map((event) => event.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      const replacements = history.filter(
        (event) =>
          event.data.type === "compaction" ||
          event.data.type === "handoff" ||
          event.data.type === "rollback",
      );
      expect(replacements.map((event) => event.data)).toEqual([
        {
          type: "compaction",
          modelProfile: "standard",
          modelId: "test/standard",
          replacementHistory: [
            { message: user },
            { message: normalizedCompactionSummary },
          ],
        },
        {
          type: "handoff",
          modelProfile: "handoff",
          modelId: "test/handoff",
          triggeringToolCallId: "handoff-call",
          replacementHistory: [{ message: handoffSummary }],
        },
        {
          type: "rollback",
          modelProfile: "handoff",
          modelId: "test/handoff",
          replacementHistory: [
            { message: handoffSummary },
            { message: handoffAssistant },
          ],
        },
      ]);
      expect(
        history.find((event) => event.data.type === "messages_summarized")
          ?.data,
      ).toMatchObject({ historyFromSeq: 8 });
      await expect(
        normalizeConversationContextCheckpoints(context, {
          executor: fixture.sql,
          bot,
        }),
      ).resolves.toMatchObject({ migrated: 0, scanned: 0 });
    } finally {
      await fixture.close();
    }
  }, 20_000);
});
