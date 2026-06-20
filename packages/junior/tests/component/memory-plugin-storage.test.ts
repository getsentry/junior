import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@sentry/junior-memory";
import {
  createPluginDbForExecutor,
  migratePluginSchemas,
  readPluginMigrations,
} from "@/chat/plugins/db";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");

function memoryMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-memory/migrations");
}

function slackContext(
  overrides: {
    channelId?: string;
    conversationId?: string;
    teamId?: string;
    threadTs?: string;
    userId?: string;
  } = {},
) {
  const teamId = overrides.teamId ?? "T123";
  const channelId = overrides.channelId ?? "C123";
  const threadTs = overrides.threadTs ?? "1718800000.000000";
  return {
    conversationId:
      overrides.conversationId ?? `slack:${channelId}:${threadTs}`,
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
  it("persists, recalls, deduplicates, and archives visible memories", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
      );
      const requesterContext = slackContext();

      const personal = await store.createMemory({
        ...requesterContext,
        content: "The requester prefers short PR summaries.",
        nowMs: TEST_NOW_MS,
        scope: "personal",
        type: "preference",
      });
      const duplicate = await store.createMemory({
        ...requesterContext,
        content: "The requester prefers short PR summaries.",
        nowMs: TEST_NOW_MS + 1,
        scope: "personal",
        type: "preference",
      });
      const conversation = await store.createMemory({
        ...requesterContext,
        content: "The channel keeps deploy runbooks in Notion.",
        nowMs: TEST_NOW_MS + 2,
        scope: "conversation",
        type: "knowledge",
      });

      expect(personal.created).toBe(true);
      expect(personal.memory.supersededAtMs).toBeUndefined();
      expect(duplicate).toMatchObject({
        created: false,
        memory: { id: personal.memory.id },
      });
      expect(conversation.created).toBe(true);

      await expect(
        store.listMemories({ ...requesterContext, nowMs: TEST_NOW_MS + 3 }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
        expect.objectContaining({ id: personal.memory.id }),
      ]);

      await expect(
        store.listMemories({
          ...slackContext({ userId: "U456" }),
          nowMs: TEST_NOW_MS + 3,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        store.listMemories({
          ...slackContext({
            channelId: "C999",
            conversationId: "slack:C999:1718800001.000000",
            threadTs: "1718800001.000000",
            userId: "U456",
          }),
          nowMs: TEST_NOW_MS + 3,
        }),
      ).resolves.toEqual([]);

      await expect(
        store.searchMemories({
          ...requesterContext,
          nowMs: TEST_NOW_MS + 3,
          query: "where are runbooks",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      await expect(
        store.searchMemories({
          ...slackContext({
            channelId: "C999",
            conversationId: "slack:C999:1718800001.000000",
            threadTs: "1718800001.000000",
          }),
          nowMs: TEST_NOW_MS + 3,
          query: "runbooks",
        }),
      ).resolves.toEqual([]);
      await expect(
        store.archiveMemory({
          ...slackContext({
            channelId: "C999",
            conversationId: "slack:C999:1718800001.000000",
            threadTs: "1718800001.000000",
          }),
          id: conversation.memory.id,
          nowMs: TEST_NOW_MS + 4,
        }),
      ).rejects.toThrow("Memory was not found in the current context.");

      const archived = await store.archiveMemory({
        ...requesterContext,
        id: personal.memory.id.slice(0, 12),
        nowMs: TEST_NOW_MS + 4,
      });
      expect(archived).toMatchObject({
        id: personal.memory.id,
        archivedAtMs: TEST_NOW_MS + 4,
      });
      await expect(
        store.listMemories({ ...requesterContext, nowMs: TEST_NOW_MS + 5 }),
      ).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("returns the original memory for idempotent create retries", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
      );
      const requesterContext = slackContext();

      const created = await store.createMemory({
        ...requesterContext,
        content: "Different content with the same retry key.",
        idempotencyKey: "explicit-create-1",
        nowMs: TEST_NOW_MS,
        observedAtMs: TEST_NOW_MS - 5_000,
        scope: "personal",
      });
      expect(created.memory.observedAtMs).toBe(TEST_NOW_MS - 5_000);

      await expect(
        store.createMemory({
          ...requesterContext,
          content: "Changed content with the same retry key.",
          idempotencyKey: "explicit-create-1",
          nowMs: TEST_NOW_MS + 1,
          scope: "personal",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id, content: created.memory.content },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("searches active visible memories before applying the result limit", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateMemorySchema(fixture);
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
      );
      const requesterContext = slackContext();
      const target = await store.createMemory({
        ...requesterContext,
        content:
          "The oldest durable memory mentions release cutover rehearsal.",
        nowMs: TEST_NOW_MS,
        scope: "conversation",
      });

      for (let index = 0; index < 205; index += 1) {
        await store.createMemory({
          ...requesterContext,
          content: `Recent unrelated memory ${index}`,
          nowMs: TEST_NOW_MS + index + 1,
          scope: "conversation",
        });
      }

      await expect(
        store.searchMemories({
          ...requesterContext,
          nowMs: TEST_NOW_MS + 300,
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
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
      );
      const requesterContext = slackContext();

      await expect(
        store.createMemory({
          ...requesterContext,
          content: "The API token is ghp_example_secret",
          nowMs: TEST_NOW_MS,
          scope: "personal",
          sensitivity: "public",
        }),
      ).rejects.toThrow("Memory content appears to contain a secret.");

      await expect(
        store.createMemory({
          ...requesterContext,
          content: "Share a sensitive personal note with the channel.",
          nowMs: TEST_NOW_MS,
          scope: "conversation",
          sensitivity: "sensitive",
        }),
      ).rejects.toThrow("Sensitive memories can only be stored personally.");

      await expect(
        store.listMemories({ ...requesterContext, nowMs: TEST_NOW_MS + 1 }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
