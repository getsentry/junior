import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { requestConversationWork } from "@/chat/task-execution/store";
import {
  ensureLegacyConversationImport,
  importConversationFromLegacy,
} from "@/chat/conversations/legacy-import";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
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

      // Re-running is a no-op: step rows already exist.
      await expect(
        importConversationFromLegacy(CONVERSATION_ID, deps),
      ).resolves.toEqual({ imported: false });
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(4);
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

    try {
      await ensureLegacyConversationImport({ conversationId: CONVERSATION_ID });
      const history = await stepStore.loadHistory(CONVERSATION_ID);
      expect(history).toHaveLength(1);
      expect(history[0]!.entry.type).toBe("pi_message");
      expect(history[0]!.createdAtMs).toBe(70);

      // Second read is idempotent: no duplicate rows.
      await ensureLegacyConversationImport({ conversationId: CONVERSATION_ID });
      expect(await stepStore.loadHistory(CONVERSATION_ID)).toHaveLength(1);
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
});
