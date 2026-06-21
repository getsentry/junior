import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-test-fixtures/pglite";
import { PluginToolInputError, type PluginDb } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import type { CreateMemoryRequest, MemoryAgent } from "../src/agent";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
} from "../src/tools";
import { createMemoryStore } from "../src/store";

const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");
const __dirname = dirname(fileURLToPath(import.meta.url));

type MemoryFixture = LocalPgliteFixture<unknown>;

function pluginDb(fixture: MemoryFixture): PluginDb {
  const db = fixture.db() as {
    delete: PluginDb["delete"];
    insert: PluginDb["insert"];
    select: PluginDb["select"];
    update: PluginDb["update"];
  };
  return {
    delete: db.delete.bind(db) as PluginDb["delete"],
    execute: (statement, params) => fixture.execute(statement, params),
    insert: db.insert.bind(db) as PluginDb["insert"],
    query: <T = unknown>(statement: string, params?: readonly unknown[]) =>
      fixture.query<T>(statement, params),
    select: db.select.bind(db) as PluginDb["select"],
    transaction: async (callback) =>
      await fixture.transaction(async () => await callback(pluginDb(fixture))),
    update: db.update.bind(db) as PluginDb["update"],
  };
}

async function createMemoryFixture(): Promise<MemoryFixture> {
  const fixture = await createLocalPgliteFixture<unknown>(memorySqlSchema);
  const migration = await readFile(
    resolve(__dirname, "../migrations/0000_dizzy_millenium_guard.sql"),
    "utf8",
  );
  await fixture.execute(migration);
  return fixture;
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

function allowMemory(
  target: "requester" | "conversation",
  onRequest?: (request: CreateMemoryRequest) => void,
): MemoryAgent {
  return {
    reviewCreateRequest(candidate) {
      onRequest?.(candidate);
      return {
        decision: "store",
        target,
        content: candidate.content,
        ...(candidate.expiresAtMs !== undefined
          ? { expiresAtMs: candidate.expiresAtMs }
          : {}),
      };
    },
  };
}

const rejectMemory: MemoryAgent = {
  reviewCreateRequest() {
    return {
      decision: "reject",
      reason: "not public/shareable",
    };
  },
};

describe("memory plugin storage", () => {
  it("persists, recalls, and archives visible memories", async () => {
    const fixture = await createMemoryFixture();

    try {
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(pluginDb(fixture), requesterContext, {
        now: () => nowMs,
      });

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
      expect(personal.memory).toMatchObject({ subjectType: "user" });
      expect(personal.memory).not.toHaveProperty("subjectKey");
      expect(conversation.created).toBe(true);
      expect(conversation.memory).toMatchObject({
        subjectType: "conversation",
      });
      expect(conversation.memory).not.toHaveProperty("subjectKey");
      await expect(
        fixture.query<{
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
        pluginDb(fixture),
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherRequesterStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      const otherConversationStore = createMemoryStore(
        pluginDb(fixture),
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
        store.searchMemories({ query: "where are runbooks" }),
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
        pluginDb(fixture),
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

  it("exposes context-bound memory management tools", async () => {
    const fixture = await createMemoryFixture();

    try {
      const reviewedRequests: CreateMemoryRequest[] = [];
      const context = {
        agent: allowMemory("requester", (request) => {
          reviewedRequests.push(request);
        }),
        db: pluginDb(fixture),
        ...slackContext(),
      };
      const tools = {
        createMemory: createMemoryCreateTool(context),
        removeMemory: createMemoryRemoveTool(context),
        listMemories: createMemoryListTool(context),
        searchMemories: createMemorySearchTool(context),
      };

      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer terse status updates.",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: {
          content: "I prefer terse status updates.",
        },
      });
      expect(reviewedRequests[0]).toMatchObject({
        content: "I prefer terse status updates.",
        runtimeContext: {
          conversationId: "slack:C123:1718800000.000000",
          requester: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
          source: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
            messageTs: "1718800000.000000",
            threadTs: "1718800000.000000",
          },
        },
      });
      await expect(
        createMemoryCreateTool({
          ...context,
          agent: allowMemory("conversation"),
        }).execute!(
          {
            content: "The channel keeps incident notes in Linear.",
          },
          { toolCallId: "tool-create-conversation" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: {
          content: "The channel keeps incident notes in Linear.",
        },
      });

      await expect(
        tools.listMemories.execute!({ limit: 10 }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "The channel keeps incident notes in Linear.",
          }),
          expect.objectContaining({
            content: "I prefer terse status updates.",
          }),
        ],
      });
      await expect(
        tools.searchMemories.execute!({ query: "incident notes" }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "The channel keeps incident notes in Linear.",
          }),
        ],
      });

      const listResult = (await tools.listMemories.execute!(
        { limit: 10 },
        {},
      )) as {
        memories: Array<{ content: string; id: string }>;
      };
      const personal = listResult.memories.find(
        (memory) => memory.content === "I prefer terse status updates.",
      );
      expect(personal).toBeDefined();
      await expect(
        tools.removeMemory.execute!({ id: personal!.id.slice(0, 12) }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memory: {
          id: personal!.id,
          content: "I prefer terse status updates.",
        },
      });
      await expect(
        tools.searchMemories.execute!({ query: "terse status" }, {}),
      ).resolves.toEqual({ ok: true, memories: [] });

      await expect(
        createMemoryCreateTool({
          ...context,
          agent: {
            reviewCreateRequest() {
              throw new Error(
                "Memory agent should not review missing tool ids.",
              );
            },
          },
        }).execute!(
          {
            content: "I prefer missing retry ids to fail.",
          },
          {},
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer invalid expiration to fail.",
            expires_at: "not-a-date",
          },
          { toolCallId: "tool-create-invalid-expiration" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer valid expiration to be stored.",
            expires_at: "2026-06-19T13:00:00+00:00",
          },
          { toolCallId: "tool-create-valid-expiration" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: {
          content: "I prefer valid expiration to be stored.",
          expiresAtMs: Date.parse("2026-06-19T13:00:00+00:00"),
        },
      });
      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer hidden fields to fail.",
            scope: "conversation",
          } as never,
          { toolCallId: "tool-create-hidden-field" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute!(
          {
            content: " \n\t ",
          },
          { toolCallId: "tool-create-empty-content" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: rejectMemory,
          db: pluginDb(fixture),
          ...slackContext(),
        }).execute!(
          {
            content: "I prefer rejected memories not to be stored.",
          },
          { toolCallId: "tool-create-rejected" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: allowMemory("requester"),
          db: pluginDb(fixture),
          source: slackContext().source,
        }).execute!(
          {
            content: "I prefer requester context failures to be visible.",
          },
          { toolCallId: "tool-create-missing-requester" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer duplicate-safe retries.",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: false,
        memory: { content: "I prefer terse status updates." },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("scopes tool create idempotency to the runtime source", async () => {
    const fixture = await createMemoryFixture();

    try {
      const firstTool = createMemoryCreateTool({
        agent: allowMemory("requester"),
        db: pluginDb(fixture),
        ...slackContext(),
      });
      const secondTool = createMemoryCreateTool({
        agent: allowMemory("requester"),
        db: pluginDb(fixture),
        ...slackContext({ threadTs: "1718800001.000000" }),
      });

      await expect(
        firstTool.execute!(
          { content: "I prefer the first remembered fact." },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });
      await expect(
        secondTool.execute!(
          { content: "I prefer the second remembered fact." },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });

      await expect(
        createMemoryStore(pluginDb(fixture), slackContext()).listMemories({}),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "I prefer the second remembered fact.",
        }),
        expect.objectContaining({
          content: "I prefer the first remembered fact.",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("stores and filters local conversation memories by local context", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(pluginDb(fixture), localContext(), {
        now: () => nowMs,
      });

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
        pluginDb(fixture),
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
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(pluginDb(fixture), slackContext(), {
        now: () => nowMs,
      });

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
        fixture.execute(
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
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(pluginDb(fixture), slackContext(), {
        now: () => nowMs,
      });

      const expired = await store.createMemory({
        content: "The requester temporarily prefers quiet deploy reminders.",
        expiresAtMs: TEST_NOW_MS + 10,
        idempotencyKey: "memory-test:expires",
      });

      nowMs = TEST_NOW_MS + 11;
      await expect(
        store.archiveMemory({ id: expired.memory.id }),
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
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(pluginDb(fixture), slackContext(), {
        now: () => nowMs,
      });
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
        store.searchMemories({ query: "cutover rehearsal" }),
      ).resolves.toEqual([expect.objectContaining({ id: target.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects hidden authority fields at the storage boundary", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(pluginDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

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

  it("rejects memory content that normalizes to empty text", async () => {
    const fixture = await createMemoryFixture();

    try {
      const store = createMemoryStore(pluginDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

      await expect(
        store.createMemory({
          content: " \n\t ",
          idempotencyKey: "memory-test:empty-content",
        }),
      ).rejects.toThrow("Memory content is required.");
      await expect(store.listMemories({})).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("rejects unsupported enum-like values at the storage boundary", async () => {
    const fixture = await createMemoryFixture();

    try {
      await expect(
        fixture.execute(
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
