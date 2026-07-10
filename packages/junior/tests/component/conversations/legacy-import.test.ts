import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { juniorConversations } from "@/db/schema";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { requestConversationWork } from "@/chat/task-execution/store";
import {
  ensureLegacyConversationImport,
  importConversationFromLegacy,
} from "@/chat/conversations/legacy-import";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { advisorChildConversationId } from "@/chat/tools/advisor/tool";
import { migrateConversationHistoryToSql } from "@/cli/upgrade/migrations/conversations-history-sql";
import type { AdvisorSessionStore } from "@/chat/tools/advisor/session-store";
import type { Conversation } from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import type {
  SessionLogEntry,
  SessionLogStore,
} from "@/chat/state/session-log";
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
    append: async () => {},
  };
}

function staticAdvisorStore(messages: PiMessage[]): AdvisorSessionStore {
  return {
    load: async () => messages,
    save: async () => {},
  };
}

describe("legacy conversation import", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = "postgres://configured.example.test/neon";
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    restoreEnv("DATABASE_URL", ORIGINAL_ENV.DATABASE_URL);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("imports steps, advisor child, and visible messages once, idempotently", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);
    const childId = advisorChildConversationId(CONVERSATION_ID);

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
        createdAtMs: 100,
        meta: { replied: true },
      },
      { id: "m2", role: "assistant", text: "reply", createdAtMs: 110 },
    ];

    const deps = {
      executor: fixture.sql,
      stepStore,
      messageStore,
      conversationRecord: conversationRecord(),
      sessionLogStore: staticSessionLogStore(entries),
      advisorSessionStore: staticAdvisorStore([
        userMessage("advisor q", 60),
        assistantMessage("advisor a", 61),
      ]),
      loadVisibleMessages: async () => visible,
    };

    try {
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: true });

      const history = await stepStore.loadHistory(CONVERSATION_ID);
      expect(
        history.map((step) => ({
          seq: step.seq,
          epoch: step.contextEpoch,
          type: step.entry.type,
        })),
      ).toEqual([
        { seq: 0, epoch: 0, type: "pi_message" },
        { seq: 1, epoch: 1, type: "context_epoch_started" },
        { seq: 2, epoch: 1, type: "pi_message" },
        { seq: 3, epoch: 1, type: "subagent_started" },
      ]);

      // Current context is exactly the highest epoch's messages.
      const current = await stepStore.loadCurrentEpoch(CONVERSATION_ID);
      expect(
        current.filter((step) => step.entry.type === "pi_message"),
      ).toHaveLength(1);

      // Advisor child is its own conversation with epoch-0 pi_message rows.
      const childHistory = await stepStore.loadHistory(childId);
      expect(childHistory.map((step) => step.entry.type)).toEqual([
        "pi_message",
        "pi_message",
      ]);
      expect(childHistory[0]!.createdAtMs).toBe(60);

      // Visible messages recorded; meta.replied becomes replied_at.
      const messages = await messageStore.list(CONVERSATION_ID);
      expect(messages.map((message) => message.messageId)).toEqual([
        "m1",
        "m2",
      ]);
      expect(messages[0]!.repliedAtMs).toBe(100);
      expect(messages[1]!.repliedAtMs).toBeUndefined();

      const [conversation] = await fixture.sql
        .db()
        .select({
          lastActivityAt: juniorConversations.lastActivityAt,
          updatedAt: juniorConversations.updatedAt,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(conversation).toMatchObject({
        lastActivityAt: new Date(900),
        updatedAt: new Date(900),
      });

      // Re-running is a no-op: step rows already exist.
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: false });
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("retries fully after a mid-import message-store failure (gate not tripped)", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

    const entries = staticSessionLogStore([
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("first", 10),
      },
    ] as SessionLogEntry[]);
    const visible: ThreadConversationMessage[] = [
      { id: "m1", role: "user", text: "hi there", createdAtMs: 100 },
      { id: "m2", role: "assistant", text: "reply", createdAtMs: 110 },
    ];

    // First attempt: message write throws before any step row is committed.
    const failingRecord = vi
      .spyOn(messageStore, "record")
      .mockRejectedValueOnce(new Error("record failed"));

    try {
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          stepStore,
          messageStore,
          conversationRecord: conversationRecord(),
          sessionLogStore: entries,
          loadVisibleMessages: async () => visible,
        }),
      ).rejects.toThrow("record failed");

      // Because the message write is the *first* write and steps are the commit
      // point, the failed attempt left no step rows, so the idempotence gate is
      // not tripped on retry.
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(0);
      expect(await messageStore.list(CONVERSATION_ID)).toHaveLength(0);

      failingRecord.mockRestore();

      // Second attempt with a working store imports BOTH messages and steps.
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, {
          executor: fixture.sql,
          stepStore,
          messageStore,
          conversationRecord: conversationRecord(),
          sessionLogStore: entries,
          loadVisibleMessages: async () => visible,
        }),
      ).resolves.toEqual({ imported: true });

      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(1);
      const messages = await messageStore.list(CONVERSATION_ID);
      expect(messages.map((message) => message.messageId)).toEqual([
        "m1",
        "m2",
      ]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("seals a completed message-only import without step rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);
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
      stepStore,
      messageStore,
      conversationRecord: conversationRecord(),
      sessionLogStore: staticSessionLogStore([]),
      loadVisibleMessages,
    };

    try {
      await messageStore.record(CONVERSATION_ID, [
        {
          messageId: "message-only",
          role: "user",
          text: "legacy visible message",
          createdAtMs: 100,
        },
      ]);
      await messageStore.markReplied(CONVERSATION_ID, "message-only", 100);

      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: true });
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: false });
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toEqual([]);
      expect(await messageStore.list(CONVERSATION_ID)).toMatchObject([
        {
          messageId: "message-only",
          meta: { author: { fullName: "Legacy User" } },
          repliedAtMs: 100,
        },
      ]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("never fabricates import-time timestamps for timestamp-less rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);
    const before = Date.now();

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        stepStore,
        messageStore,
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

      const history = await stepStore.loadHistory(CONVERSATION_ID);
      expect(history).toHaveLength(1);
      // Falls back to the conversation record's createdAt, not Date.now().
      expect(history[0]!.createdAtMs).toBe(500);
      expect(history[0]!.createdAtMs).toBeLessThan(before);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("lazily imports a straggler with a Redis log but no SQL rows, once", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

    // Route the process singletons at the fixture executor so the lazy path
    // (which resolves them internally) writes to this database.
    const db = await import("@/chat/db");
    vi.spyOn(db, "getSqlExecutor").mockReturnValue(fixture.sql as never);
    vi.spyOn(db, "getAgentStepStore").mockReturnValue(stepStore);
    vi.spyOn(db, "getConversationMessageStore").mockReturnValue(messageStore);

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(`junior:agent-session-log:${CONVERSATION_ID}`, [
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("straggler", 70),
      },
    ]);
    await stateAdapter.set(`thread-state:${CONVERSATION_ID}`, {
      conversation: {
        messages: [],
        stats: { updatedAtMs: 900 },
      },
    });

    try {
      await ensureLegacyConversationImport({ conversationId: CONVERSATION_ID });
      const history = await stepStore.loadHistory(CONVERSATION_ID);
      expect(history).toHaveLength(1);
      expect(history[0]!.entry.type).toBe("pi_message");
      expect(history[0]!.createdAtMs).toBe(70);
      const [conversation] = await fixture.sql
        .db()
        .select({ lastActivityAt: juniorConversations.lastActivityAt })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(conversation?.lastActivityAt.getTime()).toBe(900);

      // Second read is idempotent: no duplicate rows.
      await ensureLegacyConversationImport({ conversationId: CONVERSATION_ID });
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("loadConnectedMcpProviders triggers the lazy import for a straggler", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

    const db = await import("@/chat/db");
    vi.spyOn(db, "getSqlExecutor").mockReturnValue(fixture.sql as never);
    vi.spyOn(db, "getAgentStepStore").mockReturnValue(stepStore);
    vi.spyOn(db, "getConversationMessageStore").mockReturnValue(messageStore);

    // A Redis-only straggler whose durable MCP connection fact has not been
    // imported yet: the provider read must not miss it.
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(`junior:agent-session-log:${CONVERSATION_ID}`, [
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("straggler", 70),
      },
      {
        schemaVersion: 2,
        type: "mcp_provider_connected",
        sessionId: "session_0",
        provider: "linear",
      },
    ]);

    try {
      const { loadConnectedMcpProviders } =
        await import("@/chat/conversations/projection");
      await expect(
        loadConnectedMcpProviders({ conversationId: CONVERSATION_ID }),
      ).resolves.toEqual(["linear"]);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("hydrate triggers the lazy import for a Redis-only straggler and preserves replied + author", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

    // Route the process singletons at the fixture executor so the production
    // default-store hydrate path (no injected messageStore) resolves to this
    // database — the same seam the lazy import uses internally.
    const db = await import("@/chat/db");
    vi.spyOn(db, "getSqlExecutor").mockReturnValue(fixture.sql as never);
    vi.spyOn(db, "getAgentStepStore").mockReturnValue(stepStore);
    vi.spyOn(db, "getConversationMessageStore").mockReturnValue(messageStore);

    // Seed ONLY legacy Redis thread-state (a user message with a delivery mark
    // and an author) and no SQL rows: the promotion-window straggler shape.
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
            author: { userId: "U123", userName: "alice", fullName: "Alice" },
            meta: { replied: true },
          },
        ],
      },
    });

    try {
      const conversation = coerceThreadConversationState({});
      // Production default-store path: no messageStore injected, so hydrate must
      // run the lazy import (resolving the spied singletons) before reading SQL.
      await hydrateConversationMessages({
        conversation,
        conversationId: CONVERSATION_ID,
      });

      const hydratedUser = conversation.messages.find(
        (message) => message.id === "m1",
      );
      expect(hydratedUser?.text).toBe("legacy hello");
      expect(hydratedUser?.author?.userId).toBe("U123");
      expect(hydratedUser?.author?.userName).toBe("alice");
      expect(hydratedUser?.meta?.replied).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("bulk-imports legacy Redis history through the upgrade migration", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    await stateAdapter.set(`junior:agent-session-log:${CONVERSATION_ID}`, [
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: userMessage("bulk one", 10),
      },
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message: assistantMessage("bulk two", 20),
      },
    ]);

    try {
      const context = { io: { info: () => {} }, stateAdapter };
      await expect(
        migrateConversationHistoryToSql(context, { executor: fixture.sql }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        missing: 0,
        scanned: 1,
      });

      const stepStore = createSqlAgentStepStore(fixture.sql);
      const history = await stepStore.loadHistory(CONVERSATION_ID);
      expect(history.map((step) => step.entry.type)).toEqual([
        "pi_message",
        "pi_message",
      ]);

      // Re-running the bounded scan imports nothing twice.
      await expect(
        migrateConversationHistoryToSql(context, { executor: fixture.sql }),
      ).resolves.toEqual({
        existing: 1,
        migrated: 0,
        missing: 0,
        scanned: 1,
      });
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("reads legacy visible messages from a real thread-state payload", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

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
          { id: "bad", role: "user", text: 42, createdAtMs: 120 },
        ],
      },
    });

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        stepStore,
        messageStore,
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

      const imported = await messageStore.list(CONVERSATION_ID);
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

  it("preserves message author identity through import and hydration", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const messageStore = createSqlConversationMessageStore(fixture.sql);

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

    // Route the process singletons at the fixture executor so the default-store
    // hydrate path resolves to this database.
    const db = await import("@/chat/db");
    vi.spyOn(db, "getSqlExecutor").mockReturnValue(fixture.sql as never);
    vi.spyOn(db, "getAgentStepStore").mockReturnValue(stepStore);
    vi.spyOn(db, "getConversationMessageStore").mockReturnValue(messageStore);

    try {
      await importConversationFromLegacy(CONVERSATION_ID, {
        executor: fixture.sql,
        stepStore,
        messageStore,
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
    } finally {
      await fixture.close();
    }
  }, 20_000);
});
