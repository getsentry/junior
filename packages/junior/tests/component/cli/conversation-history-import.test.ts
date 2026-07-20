import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import type { JuniorSqlDatabase } from "@/db/db";
import { closeDb, getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { requestConversationWork } from "@/chat/task-execution/store";
import { importConversationFromLegacy } from "@/cli/upgrade/migrations/conversation-history/import";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { migrateConversationHistoryToSql } from "@/cli/upgrade/migrations/conversations-history-sql";
import type { LegacyAdvisorSessionReader } from "@/cli/upgrade/migrations/conversation-history/advisor-session";
import type { Conversation } from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import type {
  SessionLogEntry,
  SessionLogStore,
} from "@/cli/upgrade/migrations/conversation-history/session-log";
import type { ConversationMessage as ThreadConversationMessage } from "@/chat/state/conversation";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
} from "../../fixtures/conversation-work";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const ORIGINAL_ENV = vi.hoisted(() => ({
  DATABASE_URL: process.env.DATABASE_URL,
  JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
}));
const MODEL_ID = "test/standard";

async function processSqlStores() {
  const executor = getSqlExecutor();
  await migrateSchema(executor);
  return {
    executor,
    eventStore: getConversationEventStore(),
  };
}

async function listMessageRows(
  executor: JuniorSqlDatabase,
  conversationId: string,
) {
  const events =
    await createSqlConversationEventStore(executor).loadHistory(conversationId);
  const handledAt = new Map(
    events.flatMap((event) =>
      event.data.type === "message_handled"
        ? [[event.data.messageId, event.createdAtMs] as const]
        : [],
    ),
  );
  return events.flatMap((event) =>
    event.data.type === "message"
      ? [
          {
            messageId: event.data.messageId,
            text: event.data.text,
            repliedAtMs: handledAt.get(event.data.messageId),
          },
        ]
      : [],
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function userMessage(text: string, timestamp?: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as unknown as PiMessage;
}

function assistantMessage(text: string, timestamp?: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as unknown as PiMessage;
}

function conversationRecord(): Conversation {
  return {
    schemaVersion: 1,
    conversationId: CONVERSATION_ID,
    createdAtMs: 500,
    lastActivityAtMs: 900,
    updatedAtMs: 900,
    execution: { status: "idle", updatedAtMs: 900 },
  };
}

function staticSessionLogStore(entries: SessionLogEntry[]): SessionLogStore {
  return {
    read: async () => entries,
  };
}

function staticAdvisorStore(messages: PiMessage[]): LegacyAdvisorSessionReader {
  return {
    load: async () => messages,
  };
}

describe("operator conversation history import", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
    restoreEnv("DATABASE_URL", ORIGINAL_ENV.DATABASE_URL);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("imports events, advisor child, and visible messages once, idempotently", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);
    const childId = `advisor:${CONVERSATION_ID}`;
    const rootId = "legacy-root";
    const at = new Date(0);
    await fixture.sql
      .db()
      .insert(juniorConversations)
      .values([
        {
          conversationId: rootId,
          createdAt: at,
          lastActivityAt: at,
          updatedAt: at,
          executionStatus: "idle",
        },
        {
          conversationId: CONVERSATION_ID,
          parentConversationId: rootId,
          createdAt: at,
          lastActivityAt: at,
          updatedAt: at,
          executionStatus: "idle",
        },
      ]);

    const entries: SessionLogEntry[] = [
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("first", 10),
      },
      {
        schemaVersion: 2,
        type: "projection_reset",
        sessionId: "session_1",
        messages: [userMessage("summary", 40)],
      },
      {
        schemaVersion: 2,
        type: "subagent_started",
        sessionId: "session_1",
        subagentInvocationId: "call-1",
        subagentKind: "advisor",
        parentConversationId: CONVERSATION_ID,
        transcriptRef: {
          type: "advisor_session",
          parentConversationId: CONVERSATION_ID,
          key: `junior:${CONVERSATION_ID}:advisor_session`,
        },
        historyMode: "shared",
        createdAtMs: 50,
      },
    ] as SessionLogEntry[];

    const visible: ThreadConversationMessage[] = [
      {
        id: "m1",
        role: "user",
        text: "hi there",
        createdAtMs: 30,
        meta: { replied: true },
      },
      { id: "m2", role: "assistant", text: "reply", createdAtMs: 45 },
    ];

    const deps = {
      executor: fixture.sql,
      modelId: MODEL_ID,
      conversationRecord: conversationRecord(),
      sessionLogStore: staticSessionLogStore(entries),
      advisorSessionStore: staticAdvisorStore([
        userMessage("advisor q", 960),
        assistantMessage("advisor a", 961),
      ]),
      loadVisibleMessages: async () => visible,
    };

    try {
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: true });

      const history = await eventStore.loadHistory(CONVERSATION_ID);
      expect(
        history.map((event) => ({
          seq: event.seq,
          epoch: event.historyVersion,
          type: event.data.type,
        })),
      ).toEqual([
        { seq: 0, epoch: 0, type: "agent_step" },
        { seq: 1, epoch: 0, type: "message" },
        { seq: 2, epoch: 0, type: "message_handled" },
        { seq: 3, epoch: 1, type: "compaction" },
        { seq: 4, epoch: 1, type: "message" },
        { seq: 5, epoch: 1, type: "subagent_started" },
      ]);

      // Upgrade emits the same canonical checkpoint shape as live writes.
      const current = await eventStore.loadCurrentHistory(CONVERSATION_ID);
      expect(current[0]?.data).toEqual({
        type: "compaction",
        modelProfile: "standard",
        modelId: MODEL_ID,
        replacementHistory: [
          {
            message: userMessage("summary", 40),
            provenance: { authority: "context" },
          },
        ],
      });

      // Advisor child is its own conversation with epoch-0 message events.
      const childHistory = await eventStore.loadHistory(childId);
      expect(childHistory.map((event) => event.data.type)).toEqual([
        "agent_step",
        "agent_step",
      ]);
      expect(childHistory[0]!.createdAtMs).toBe(960);

      // Visible messages recorded; meta.replied becomes replied_at.
      const messages = await listMessageRows(fixture.sql, CONVERSATION_ID);
      expect(messages.map((message) => message.messageId)).toEqual([
        "m1",
        "m2",
      ]);
      expect(messages[0]!.repliedAtMs).toBe(30);
      expect(messages[1]!.repliedAtMs).toBeUndefined();

      const conversations = await fixture.sql
        .db()
        .select({
          conversationId: juniorConversations.conversationId,
          createdAt: juniorConversations.createdAt,
          lastActivityAt: juniorConversations.lastActivityAt,
          parentConversationId: juniorConversations.parentConversationId,
          updatedAt: juniorConversations.updatedAt,
        })
        .from(juniorConversations)
        .where(
          inArray(juniorConversations.conversationId, [
            CONVERSATION_ID,
            childId,
          ]),
        );
      expect(conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: CONVERSATION_ID,
            lastActivityAt: new Date(961),
            updatedAt: new Date(961),
          }),
          expect.objectContaining({
            conversationId: childId,
            createdAt: new Date(960),
            lastActivityAt: new Date(961),
            parentConversationId: CONVERSATION_ID,
            updatedAt: new Date(961),
          }),
        ]),
      );

      // Re-running is a no-op: event rows already exist.
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: false });
      expect(await eventStore.loadHistory(CONVERSATION_ID)).toHaveLength(6);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("rolls back events when the transactional message import fails", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);

    const entries = staticSessionLogStore([
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("first", 10),
      },
    ] as SessionLogEntry[]);
    const invalidVisible: ThreadConversationMessage[] = [
      { id: "m1", role: "user", text: "hi there", createdAtMs: 100 },
      { id: "m1", role: "assistant", text: "duplicate", createdAtMs: 110 },
    ];

    try {
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          modelId: MODEL_ID,
          conversationRecord: conversationRecord(),
          sessionLogStore: entries,
          loadVisibleMessages: async () => invalidVisible,
        }),
      ).rejects.toThrow(
        'Failed query: insert into "junior_conversation_events"',
      );

      // Messages and events share one transaction, so neither side commits.
      expect(await eventStore.loadHistory(CONVERSATION_ID)).toHaveLength(0);
      expect(await listMessageRows(fixture.sql, CONVERSATION_ID)).toHaveLength(
        0,
      );

      const visible: ThreadConversationMessage[] = [
        { id: "m1", role: "user", text: "hi there", createdAtMs: 100 },
        { id: "m2", role: "assistant", text: "reply", createdAtMs: 110 },
      ];
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          modelId: MODEL_ID,
          conversationRecord: conversationRecord(),
          sessionLogStore: entries,
          loadVisibleMessages: async () => visible,
        }),
      ).resolves.toEqual({ imported: true });

      expect(await eventStore.loadHistory(CONVERSATION_ID)).toHaveLength(3);
      const messages = await listMessageRows(fixture.sql, CONVERSATION_ID);
      expect(messages.map((message) => message.messageId)).toEqual([
        "m1",
        "m2",
      ]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("treats event-backed visible-message writes as an import seal", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);
    const loadVisibleMessages = vi.fn(async () => [
      {
        id: "message-only",
        role: "user" as const,
        text: "legacy visible message",
        createdAtMs: 100,
        author: { fullName: "Legacy User" },
        meta: { replied: true },
      },
    ]);
    const deps = {
      executor: fixture.sql,
      modelId: MODEL_ID,
      conversationRecord: conversationRecord(),
      sessionLogStore: staticSessionLogStore([]),
      loadVisibleMessages,
    };

    try {
      await eventStore.append(CONVERSATION_ID, [
        {
          idempotencyKey: "message:message-only",
          data: {
            type: "message",
            messageId: "message-only",
            role: "user",
            text: "legacy visible message",
          },
          createdAtMs: 100,
        },
        {
          idempotencyKey: "message:message-only:handled",
          data: { type: "message_handled", messageId: "message-only" },
          createdAtMs: 100,
        },
      ]);

      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: false });
      expect(await eventStore.loadHistory(CONVERSATION_ID)).toHaveLength(2);
      expect(await listMessageRows(fixture.sql, CONVERSATION_ID)).toMatchObject(
        [
          {
            messageId: "message-only",
            repliedAtMs: 100,
          },
        ],
      );
      const [conversation] = await fixture.sql
        .db()
        .select({
          lastActivityAt: juniorConversations.lastActivityAt,
          updatedAt: juniorConversations.updatedAt,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(conversation).toMatchObject({
        lastActivityAt: new Date(100),
        updatedAt: new Date(100),
      });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("treats transitional SQL rows as an existing import without decoding them", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    try {
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({
          conversationId: CONVERSATION_ID,
          schemaVersion: 1,
          createdAt: new Date(1_000),
          lastActivityAt: new Date(1_000),
          updatedAt: new Date(1_000),
          executionStatus: "idle",
        });
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values({
          conversationId: CONVERSATION_ID,
          seq: 0,
          historyVersion: 0,
          schemaVersion: 1,
          type: "messages_summarized",
          payload: {
            compactions: [
              {
                id: "transitional",
                summary: "not canonical until the next upgrade step",
                createdAtMs: 1_000,
                coveredMessageIds: ["message-1"],
              },
            ],
          },
          createdAt: new Date(1_000),
        });

      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          modelId: MODEL_ID,
          sessionLogStore: staticSessionLogStore([]),
          loadVisibleMessages: async () => [],
        }),
      ).resolves.toEqual({ imported: false });
    } finally {
      await fixture.close();
    }
  });

  it("never fabricates import-time timestamps for timestamp-less rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);
    const before = Date.now();

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        modelId: MODEL_ID,
        conversationRecord: conversationRecord(),
        sessionLogStore: staticSessionLogStore([
          {
            schemaVersion: 2,
            type: "pi_message",
            sessionId: "session_0",
            message: userMessage("no timestamp"),
          },
        ] as SessionLogEntry[]),
        loadVisibleMessages: async () => [],
      });

      const history = await eventStore.loadHistory(CONVERSATION_ID);
      expect(history).toHaveLength(1);
      // Falls back to the conversation record's createdAt, not Date.now().
      expect(history[0]!.createdAtMs).toBe(500);
      expect(history[0]!.createdAtMs).toBeLessThan(before);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("hydrates visible messages from events without message-table rows", async () => {
    const { eventStore } = await processSqlStores();
    await eventStore.append(CONVERSATION_ID, [
      {
        data: {
          type: "message",
          messageId: "event-only",
          role: "user",
          text: "canonical event text",
        },
        createdAtMs: 100,
      },
    ]);

    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation,
      conversationId: CONVERSATION_ID,
    });

    expect(conversation.messages).toEqual([
      {
        id: "event-only",
        role: "user",
        text: "canonical event text",
        createdAtMs: 100,
      },
    ]);
  }, 20_000);

  it("does not consult legacy Redis during live hydration", async () => {
    const { eventStore } = await processSqlStores();
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(`thread-state:${CONVERSATION_ID}`, {
      conversation: {
        messages: [
          {
            id: "redis-only",
            role: "user",
            text: "legacy text must stay outside the runtime",
            createdAtMs: 100,
          },
        ],
      },
    });

    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation,
      conversationId: CONVERSATION_ID,
    });

    expect(conversation.messages).toEqual([]);
    expect(await eventStore.loadHistory(CONVERSATION_ID)).toEqual([]);
  }, 20_000);

  it("rejects a legacy import when event history was already purged", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);

    await fixture.sql
      .db()
      .insert(juniorConversations)
      .values({
        conversationId: CONVERSATION_ID,
        createdAt: new Date(100),
        lastActivityAt: new Date(100),
        updatedAt: new Date(100),
        executionStatus: "idle",
        transcriptPurgedAt: new Date(200),
      });

    try {
      const result = await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        modelId: MODEL_ID,
        sessionLogStore: staticSessionLogStore([
          {
            schemaVersion: 2,
            type: "pi_message",
            sessionId: "session_0",
            message: userMessage("must stay purged", 50),
          },
        ]),
        loadVisibleMessages: async () => [
          {
            id: "legacy-visible",
            role: "user",
            text: "must also stay purged",
            createdAtMs: 60,
          },
        ],
      });

      expect(result).toEqual({ imported: false });
      expect(await eventStore.loadHistory(CONVERSATION_ID)).toEqual([]);
      expect(await listMessageRows(fixture.sql, CONVERSATION_ID)).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("bulk-imports legacy Redis history through the upgrade migration", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const conversationIds = [
      CONVERSATION_ID,
      `${CONVERSATION_ID}:page-2`,
      `${CONVERSATION_ID}:page-3`,
    ];
    for (const [index, conversationId] of conversationIds.entries()) {
      await requestConversationWork({
        conversationId,
        destination: SLACK_DESTINATION,
        nowMs: 2_000 + index,
        state: stateAdapter,
      });
      await stateAdapter.set(`junior:agent-session-log:${conversationId}`, [
        {
          schemaVersion: 2,
          type: "pi_message",
          sessionId: "session_0",
          message: userMessage(`bulk ${index}`, 10 + index),
        },
      ]);
    }

    try {
      await migrateSchema(fixture.sql);
      const context = { io: { info: () => {} }, stateAdapter };
      await expect(
        migrateConversationHistoryToSql(context, {
          batchSize: 2,
          executor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 3,
        missing: 0,
        scanned: 3,
      });

      const eventStore = createSqlConversationEventStore(fixture.sql);
      for (const conversationId of conversationIds) {
        const history = await eventStore.loadHistory(conversationId);
        expect(history.map((event) => event.data.type)).toEqual(["agent_step"]);
      }

      // Re-running every page imports nothing twice.
      await expect(
        migrateConversationHistoryToSql(context, {
          batchSize: 2,
          executor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 3,
        migrated: 0,
        missing: 0,
        scanned: 3,
      });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("replaces NUL characters in imported conversation events", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const eventStore = createSqlConversationEventStore(fixture.sql);

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        modelId: MODEL_ID,
        conversationRecord: conversationRecord(),
        sessionLogStore: staticSessionLogStore([
          {
            schemaVersion: 2,
            type: "pi_message",
            sessionId: "session_0",
            message: assistantMessage(
              "before\u0000after and literal \\u0000",
              10,
            ),
          } as SessionLogEntry,
        ]),
        loadVisibleMessages: async () => [],
      });

      expect(
        (await eventStore.loadHistory(CONVERSATION_ID))[0]?.data,
      ).toMatchObject({
        type: "agent_step",
        message: {
          content: [{ text: "before after and literal \\u0000", type: "text" }],
        },
      });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("reads legacy visible messages from a real thread-state payload", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    // Persisted pre-cutover shape: the visible transcript nested under
    // `conversation.messages`, which the live thread-state contract no longer
    // reads. No loadVisibleMessages injection — exercise the real parser.
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(`thread-state:${CONVERSATION_ID}`, {
      conversation: {
        schemaVersion: 1,
        messages: [
          {
            id: "m1",
            role: "user",
            text: "legacy hello",
            createdAtMs: 100,
            meta: { replied: true, slackTs: "100.1" },
          },
          {
            id: "m2",
            role: "assistant",
            text: "legacy reply",
            createdAtMs: 110,
          },
        ],
      },
    });

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        modelId: MODEL_ID,
        conversationRecord: conversationRecord(),
        sessionLogStore: staticSessionLogStore([
          {
            schemaVersion: 2,
            type: "pi_message",
            sessionId: "session_0",
            message: userMessage("first", 10),
          } as SessionLogEntry,
        ]),
        advisorSessionStore: staticAdvisorStore([]),
      });

      const imported = await listMessageRows(fixture.sql, CONVERSATION_ID);
      expect(
        imported.map((message) => ({
          messageId: message.messageId,
          text: message.text,
          replied: message.repliedAtMs !== undefined,
        })),
      ).toEqual([
        { messageId: "m1", text: "legacy hello", replied: true },
        { messageId: "m2", text: "legacy reply", replied: false },
      ]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("rejects malformed legacy visible messages", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(`thread-state:${CONVERSATION_ID}`, {
      conversation: {
        messages: [{ id: "bad", role: "user", text: 42, createdAtMs: 120 }],
      },
    });

    try {
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          modelId: MODEL_ID,
          conversationRecord: conversationRecord(),
          sessionLogStore: staticSessionLogStore([]),
          advisorSessionStore: staticAdvisorStore([]),
        }),
      ).rejects.toThrow("Invalid input");
      await expect(
        listMessageRows(fixture.sql, CONVERSATION_ID),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("preserves message author identity through import and hydration", async () => {
    const { executor } = await processSqlStores();

    // The resume/continuation paths key off the persisted user message's
    // author userId, so the import must fold `author` into `meta.author` just
    // like runtime-recorded rows do.
    const visible: ThreadConversationMessage[] = [
      {
        id: "m1",
        role: "user",
        text: "hi there",
        createdAtMs: 100,
        author: { userId: "U123", userName: "alice", fullName: "Alice" },
        meta: { replied: true },
      },
      { id: "m2", role: "assistant", text: "reply", createdAtMs: 110 },
    ];

    await importConversationFromLegacy(CONVERSATION_ID, {
      executor,
      modelId: MODEL_ID,
      conversationRecord: conversationRecord(),
      sessionLogStore: staticSessionLogStore([
        {
          schemaVersion: 2,
          type: "pi_message",
          sessionId: "session_0",
          message: userMessage("first", 10),
        } as SessionLogEntry,
      ]),
      loadVisibleMessages: async () => visible,
    });

    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation,
      conversationId: CONVERSATION_ID,
    });

    const hydratedUser = conversation.messages.find(
      (message) => message.id === "m1",
    );
    expect(hydratedUser?.author?.userId).toBe("U123");
    expect(hydratedUser?.author?.userName).toBe("alice");
    // `replied === true` rides the `replied_at` column, not `meta`.
    expect(hydratedUser?.meta?.replied).toBe(true);
  }, 20_000);
});
