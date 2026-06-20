import path from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPlugin, createMemoryStore } from "@sentry/junior-memory";
import { defineJuniorPlugins } from "@/plugins";
import {
  createPluginDbForExecutor,
  migratePluginSchemas,
  readPluginMigrations,
} from "@/chat/plugins/db";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");

const NEON = vi.hoisted(() => ({
  executor: undefined as
    | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>["executor"]
    | undefined,
}));

vi.mock("@/chat/sql/executor", () => ({
  createJuniorSqlExecutor: vi.fn(() => {
    if (!NEON.executor) {
      throw new Error("Missing test SQL executor");
    }
    return {
      db: NEON.executor.db.bind(NEON.executor),
      execute: NEON.executor.execute.bind(NEON.executor),
      query: NEON.executor.query.bind(NEON.executor),
      transaction: NEON.executor.transaction.bind(NEON.executor),
      withLock: NEON.executor.withLock.bind(NEON.executor),
      close: async () => {},
    };
  }),
}));

function memoryMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-memory/migrations");
}

function slackContext(
  overrides: {
    channelId?: string;
    teamId?: string;
    threadTs?: string;
    userId?: string;
  } = {},
) {
  const teamId = overrides.teamId ?? "T123";
  const channelId = overrides.channelId ?? "C123";
  const threadTs = overrides.threadTs ?? "1718800000.000000";
  return {
    conversationId: `slack:${channelId}:${threadTs}`,
    requester: {
      platform: "slack" as const,
      teamId,
      userId: overrides.userId ?? "U123",
    },
    source: {
      platform: "slack" as const,
      teamId,
      channelId,
      messageTs: threadTs,
      threadTs,
    },
  };
}

function localContext(
  overrides: { conversationId?: string; userId?: string } = {},
) {
  const conversationId = overrides.conversationId ?? "local:junior:memory-test";
  return {
    conversationId,
    requester: {
      platform: "local" as const,
      userId: overrides.userId ?? "local-user",
    },
    source: {
      platform: "local" as const,
      conversationId,
    },
  };
}

async function migrateMemorySchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  await migratePluginSchemas(
    fixture.executor,
    readPluginMigrations({
      dir: memoryMigrationsDir(),
      pluginName: "memory",
    }),
  );
}

describe("memory plugin SQL storage", () => {
  it("applies packaged migrations through plugin discovery", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    NEON.executor = fixture.executor;

    try {
      await expect(
        migratePluginsToSql({
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([createMemoryPlugin()]),
          sqlDatabaseUrl: "postgres://configured.example.test/neon",
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        missing: 0,
        scanned: 1,
      });

      await expect(
        fixture.executor.query<{ table_name: string }>(
          `
SELECT table_name
FROM information_schema.tables
WHERE table_name = 'junior_memory_memories'
`,
        ),
      ).resolves.toEqual([{ table_name: "junior_memory_memories" }]);
    } finally {
      NEON.executor = undefined;
      await stateAdapter.disconnect();
      await fixture.close();
    }
  }, 15_000);

  it("persists, recalls, and archives visible memories", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => nowMs },
      );

      const personal = await store.createMemory({
        content: "The requester prefers short PR summaries.",
        idempotencyKey: "memory-test:personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "The channel keeps deploy runbooks in Notion.",
        idempotencyKey: "memory-test:conversation",
      });

      expect(personal.created).toBe(true);
      expect(personal.memory).toMatchObject({
        subjectType: "user",
      });
      expect(personal.memory).not.toHaveProperty("subjectKey");
      expect(personal.memory.supersededAtMs).toBeUndefined();
      expect(conversation.created).toBe(true);
      expect(conversation.memory).toMatchObject({
        subjectType: "conversation",
      });
      expect(conversation.memory).not.toHaveProperty("subjectKey");
      await expect(
        fixture.executor.query<{
          id: string;
          subject_key: string;
          subject_type: string;
        }>(
          `
SELECT id, subject_type, subject_key
FROM junior_memory_memories
ORDER BY created_at_ms ASC
`,
        ),
      ).resolves.toEqual([
        {
          id: personal.memory.id,
          subject_key: "slack:T123:U123",
          subject_type: "user",
        },
        {
          id: conversation.memory.id,
          subject_key: "slack:T123:C123:1718800000.000000",
          subject_type: "conversation",
        },
      ]);

      nowMs = TEST_NOW_MS + 3;
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
        expect.objectContaining({ id: personal.memory.id }),
      ]);

      const otherRequesterStore = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherRequesterStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      const otherConversationStore = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        slackContext({
          channelId: "C999",
          threadTs: "1718800001.000000",
          userId: "U456",
        }),
        { now: () => nowMs },
      );
      await expect(otherConversationStore.listMemories({})).resolves.toEqual(
        [],
      );

      await expect(
        store.searchMemories({
          query: "where are runbooks",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        otherConversationStore.searchMemories({ query: "runbooks" }),
      ).resolves.toEqual([]);
      nowMs = TEST_NOW_MS + 4;
      await expect(
        otherConversationStore.archiveMemory({ id: conversation.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");
      const otherTeamStore = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        slackContext({ teamId: "T999", userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherTeamStore.listMemories({})).resolves.toEqual([]);

      const archived = await store.archiveMemory({
        id: personal.memory.id.slice(0, 12),
      });
      expect(archived).toMatchObject({
        id: personal.memory.id,
        archivedAtMs: TEST_NOW_MS + 4,
      });
      nowMs = TEST_NOW_MS + 5;
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        store.searchMemories({ query: "summaries" }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores and filters local conversation memories by local context", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      let nowMs = TEST_NOW_MS;
      const requesterContext = localContext();
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => nowMs },
      );

      const personal = await store.createMemory({
        content: "The requester prefers local CLI memory checks.",
        idempotencyKey: "memory-test:local-personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "This local session tracks memory plugin validation.",
        idempotencyKey: "memory-test:local-conversation",
      });

      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
        expect.objectContaining({ id: personal.memory.id }),
      ]);
      await expect(
        store.searchMemories({ query: "validation" }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);

      const otherConversationStore = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        localContext({ conversationId: "local:junior:other-memory-test" }),
        { now: () => nowMs },
      );
      await expect(otherConversationStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: personal.memory.id }),
      ]);
      await expect(
        otherConversationStore.archiveMemory({ id: conversation.memory.id }),
      ).rejects.toThrow("Memory was not found in the current context.");

      nowMs = TEST_NOW_MS + 2;
      const archived = await store.archiveMemory({ id: personal.memory.id });
      expect(archived).toMatchObject({
        archivedAtMs: TEST_NOW_MS + 2,
        id: personal.memory.id,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("returns the original memory for idempotent create retries", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => nowMs },
      );

      const created = await store.createMemory({
        content: "Different content with the same retry key.",
        idempotencyKey: "explicit-create-1",
      });
      expect(created.memory.observedAtMs).toBe(TEST_NOW_MS);

      nowMs = TEST_NOW_MS + 1;
      await expect(
        store.createMemory({
          content: "Changed content with the same retry key.",
          idempotencyKey: "explicit-create-1",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: created.memory.content },
      });
      await expect(
        fixture.executor.execute(
          `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  subject_type,
  subject_key,
  content,
  source_platform,
  source_key,
  idempotency_key,
  observed_at_ms,
  created_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
)
`,
          [
            "mem_duplicate_idempotency",
            "personal",
            "slack:T123:U123",
            "knowledge",
            "user",
            "slack:T123:U123",
            "Duplicate raw insert with same retry key.",
            "slack",
            "slack:T123:C123:1718800000.000000",
            "explicit-create-1",
            nowMs,
            nowMs,
          ],
        ),
      ).rejects.toThrow("duplicate key value violates unique constraint");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("treats expired memories as inactive for archive and recreate", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => nowMs },
      );

      const expired = await store.createMemory({
        content: "The requester temporarily prefers quiet deploy reminders.",
        expiresAtMs: TEST_NOW_MS + 10,
        idempotencyKey: "memory-test:expires",
      });

      nowMs = TEST_NOW_MS + 11;
      await expect(
        store.archiveMemory({
          id: expired.memory.id,
        }),
      ).rejects.toThrow("Memory was not found in the current context.");
      await expect(store.searchMemories({ query: "quiet" })).resolves.toEqual(
        [],
      );

      nowMs = TEST_NOW_MS + 12;
      const recreated = await store.createMemory({
        content: "The requester temporarily prefers quiet deploy reminders.",
        idempotencyKey: "memory-test:expires-recreated",
      });

      expect(recreated).toMatchObject({
        created: true,
        memory: { content: expired.memory.content },
      });
      expect(recreated.memory.id).not.toBe(expired.memory.id);
      await expect(store.searchMemories({ query: "quiet" })).resolves.toEqual([
        expect.objectContaining({ id: recreated.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("searches active visible memories before applying the result limit", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => nowMs },
      );
      const target = await store.createConversationMemory({
        content:
          "The oldest durable memory mentions release cutover rehearsal.",
        idempotencyKey: "memory-test:search-target",
      });

      for (let index = 0; index < 205; index += 1) {
        nowMs = TEST_NOW_MS + index + 1;
        await store.createConversationMemory({
          content: `Recent unrelated memory ${index}`,
          idempotencyKey: `memory-test:search-recent-${index}`,
        });
      }

      nowMs = TEST_NOW_MS + 300;
      await expect(
        store.searchMemories({
          query: "cutover rehearsal",
        }),
      ).resolves.toEqual([expect.objectContaining({ id: target.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects deterministic policy violations before storage", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const requesterContext = slackContext();
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        requesterContext,
        { now: () => TEST_NOW_MS },
      );

      await expect(
        store.createMemory({
          content: "The API token is ghp_example_secret",
          idempotencyKey: "memory-test:secret",
        }),
      ).rejects.toThrow("Memory content appears to contain a secret.");
      await expect(
        store.createMemory({
          content: "I have a medical issue.",
          idempotencyKey: "memory-test:medical",
        }),
      ).rejects.toThrow(
        "Memory content appears to contain non-public or sensitive information.",
      );
      await expect(
        store.createConversationMemory({
          content: "Alice is interviewing elsewhere.",
          idempotencyKey: "memory-test:interviewing",
        }),
      ).rejects.toThrow(
        "Memory content appears to contain non-public or sensitive information.",
      );

      await expect(
        store.createMemory({
          content: "David is on the billing team.",
          idempotencyKey: "memory-test:third-party",
        }),
      ).rejects.toThrow(
        "User-subject memories can only store first-person facts about the current requester.",
      );
      await expect(
        store.createMemory({
          content: "The requester prefers short PR summaries.",
          idempotencyKey: "memory-test:smuggle",
          scope: "conversation",
          subjectKey: "slack:T123:U999",
          subjectType: "general",
          type: "preference",
        } as unknown as Parameters<typeof store.createMemory>[0]),
      ).rejects.toThrow(/Invalid input|Unrecognized key/);
      await expect(
        store.listMemories({
          requester: { platform: "local", userId: "local-user" },
        } as unknown as Parameters<typeof store.listMemories>[0]),
      ).rejects.toThrow(/Invalid input|Unrecognized key/);

      await expect(store.listMemories({})).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects unsupported enum-like values at the storage boundary", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);

      await expect(
        fixture.executor.execute(
          `
INSERT INTO junior_memory_memories (
  id,
  scope,
  scope_key,
  type,
  subject_type,
  subject_key,
  content,
  source_platform,
  source_key,
  observed_at_ms,
  created_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
)
`,
          [
            "mem_invalid_enum",
            "workspace",
            "slack:T123:U123",
            "knowledge",
            "general",
            null,
            "Unsupported scope value.",
            "slack",
            "slack:T123:C123:1718800000.000000",
            TEST_NOW_MS,
            TEST_NOW_MS,
          ],
        ),
      ).rejects.toThrow("violates check constraint");
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
