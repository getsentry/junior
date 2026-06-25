import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  pgliteVectorExtension,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import {
  createLocalSource,
  createSlackSource,
  PluginToolInputError,
  type PluginLogger,
  type PluginModel,
  type PluginState,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import * as memorySqlSchema from "../src/db/schema";
import {
  createMemoryAgent,
  type CreateMemoryRequest,
  type MemoryAgent,
} from "../src/agent";
import { createMemoryPlugin } from "../src/plugin";
import {
  createMemoryCreateTool,
  createMemoryListTool,
  createMemoryRemoveTool,
  createMemorySearchTool,
} from "../src/tools";
import { createMemoryStore, type MemoryDb } from "../src/store";

const TEST_NOW_MS = Date.parse("2026-06-19T12:00:00.000Z");
const TEST_EMBEDDING_DIMENSIONS = 1536;
const __dirname = dirname(fileURLToPath(import.meta.url));

type MemoryFixture = LocalPgliteFixture<MemoryDb>;

const noopLogger: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

const memoryState: PluginState = {
  async delete() {},
  async get() {
    return undefined;
  },
  async set() {},
  async setIfNotExists() {
    return true;
  },
  async withLock(_key, _ttlMs, callback) {
    return await callback();
  },
};

const defaultEmbedding = unitEmbedding(0);

function memoryDb(fixture: MemoryFixture): MemoryDb {
  return fixture.db();
}

async function createMemoryFixture(): Promise<MemoryFixture> {
  const fixture = await createLocalPgliteFixture<MemoryDb>(memorySqlSchema, {
    extensions: { vector: pgliteVectorExtension },
  });
  const migrationsDir = resolve(__dirname, "../migrations");
  const migrations = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrations) {
    const migration = await readFile(resolve(migrationsDir, migrationFile), {
      encoding: "utf8",
    });
    await fixture.execute(migration);
  }
  return fixture;
}

function unitEmbedding(index: number): number[] {
  const embedding = Array.from({ length: TEST_EMBEDDING_DIMENSIONS }, () => 0);
  embedding[index] = 1;
  return embedding;
}

function createTestEmbedder(
  vectors: Record<string, number[]> = {},
  overrides: { dimensions?: number; model?: string; provider?: string } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    async embedTexts(input: { texts: string[] }) {
      calls.push(input.texts);
      return {
        dimensions: overrides.dimensions ?? TEST_EMBEDDING_DIMENSIONS,
        model: overrides.model ?? "test-embedding-model",
        provider: overrides.provider ?? "test-embedding-provider",
        vectors: input.texts.map((text) => vectors[text] ?? defaultEmbedding),
      };
    },
  };
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
    source: createSlackSource({
      teamId,
      channelId,
      messageTs: threadTs,
      threadTs,
    }),
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
    source: createLocalSource(conversationId),
  };
}

function testCanonicalContent(content: string): string {
  return content.replace(/^I prefer /, "Prefers ").replace(/^I use /, "Uses ");
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
        content: testCanonicalContent(candidate.content),
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
      reason: "not_public_shareable",
    };
  },
};

describe("memory plugin storage", () => {
  it("normalizes nullable structured review responses", async () => {
    const calls: Parameters<PluginModel["completeObject"]>[0][] = [];
    const model: PluginModel = {
      async completeObject(input) {
        calls.push(input);
        return {
          object: {
            decision: "store",
            target: "requester",
            content: "Uses qa-structured-output in CLI QA.",
            reason: null,
            expiresAtMs: null,
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.reviewCreateRequest({
        content: "I use qa-structured-output in CLI QA.",
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual({
      decision: "store",
      target: "requester",
      content: "Uses qa-structured-output in CLI QA.",
    });
    expect(calls[0]?.schema).toBeDefined();
  });

  it("normalizes nullable structured rejection responses", async () => {
    const model: PluginModel = {
      async completeObject() {
        return {
          object: {
            decision: "reject",
            target: null,
            content: null,
            reason: "not_public_shareable",
            expiresAtMs: null,
          },
        };
      },
    };
    const agent = createMemoryAgent(model);

    await expect(
      agent.reviewCreateRequest({
        content: "remember this",
        runtimeContext: localContext(),
      }),
    ).resolves.toEqual({
      decision: "reject",
      reason: "not_public_shareable",
    });
  });

  it("persists, recalls, and archives visible memories", async () => {
    const fixture = await createMemoryFixture();

    try {
      const requesterContext = slackContext();
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), requesterContext, {
        now: () => nowMs,
      });

      const personal = await store.createMemory({
        content: "Prefers short PR summaries.",
        idempotencyKey: "memory-test:personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "Deploy runbooks live in Notion.",
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
        memoryDb(fixture),
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      );
      await expect(otherRequesterStore.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: conversation.memory.id }),
      ]);
      const otherConversationStore = createMemoryStore(
        memoryDb(fixture),
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
        memoryDb(fixture),
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

  it("stores derived embeddings and uses vector recall before lexical fallback", async () => {
    const fixture = await createMemoryFixture();

    try {
      const reactMemory = "Uses React hooks for UI state.";
      const mangoMemory = "Favorite CLI QA snack is mango chips.";
      const embedder = createTestEmbedder({
        [reactMemory]: unitEmbedding(1),
        [mangoMemory]: unitEmbedding(2),
        "client rendering library": unitEmbedding(1),
      });
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });

      const react = await store.createMemory({
        content: reactMemory,
        idempotencyKey: "memory-test:embedding-react",
      });
      nowMs += 1;
      await store.createMemory({
        content: mangoMemory,
        idempotencyKey: "memory-test:embedding-mango",
      });

      const embeddingRows = await memoryDb(fixture)
        .select()
        .from(memorySqlSchema.juniorMemoryEmbeddings);
      expect(embeddingRows).toHaveLength(2);
      expect(embeddingRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dimensions: TEST_EMBEDDING_DIMENSIONS,
            memoryId: react.memory.id,
            metric: "cosine",
            model: "test-embedding-model",
            provider: "test-embedding-provider",
          }),
        ]),
      );
      const results = await store.searchMemories({
        query: "client rendering library",
      });
      expect(results[0]).toEqual(
        expect.objectContaining({ id: react.memory.id }),
      );
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("fuses vector and lexical matches before applying the search limit", async () => {
    const fixture = await createMemoryFixture();

    try {
      const query = "exact lexical preference";
      const vectorMemories = [
        "Uses server components for dashboard filters.",
        "Keeps migrations generated through drizzle-kit.",
        "Prefers short-lived QA branches.",
        "Stores runbooks near deploy checklists.",
      ];
      const lexicalMemory = "Exact lexical preference lives in this memory.";
      const vectors: Record<string, number[]> = {
        [query]: unitEmbedding(1),
      };
      for (const memory of vectorMemories) {
        vectors[memory] = unitEmbedding(1);
      }
      const embedder = createTestEmbedder(vectors);
      let nowMs = TEST_NOW_MS;
      const vectorStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => nowMs,
      });
      for (const [index, memory] of vectorMemories.entries()) {
        nowMs += 1;
        await vectorStore.createMemory({
          content: memory,
          idempotencyKey: `memory-test:fusion-vector-${index}`,
        });
      }
      nowMs += 1;
      const lexicalStore = createMemoryStore(
        memoryDb(fixture),
        slackContext(),
        {
          now: () => nowMs,
        },
      );
      const lexical = await lexicalStore.createMemory({
        content: lexicalMemory,
        idempotencyKey: "memory-test:fusion-lexical",
      });

      await expect(
        vectorStore.searchMemories({ limit: 1, query }),
      ).resolves.toEqual([expect.objectContaining({ id: lexical.memory.id })]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not duplicate embeddings for idempotent create retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      const embedder = createTestEmbedder();
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const created = await store.createMemory({
        content: "Prefers duplicate-safe vector writes.",
        idempotencyKey: "memory-test:embedding-idempotent",
      });
      await expect(
        store.createMemory({
          content: "Changed retry content should not be re-embedded.",
          idempotencyKey: "memory-test:embedding-idempotent",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toHaveLength(1);
      expect(embedder.calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("backfills missing embeddings on idempotent create retries", async () => {
    const fixture = await createMemoryFixture();

    try {
      const content = "Prefers derived embeddings to be repairable.";
      const firstStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });
      const created = await firstStore.createMemory({
        content,
        idempotencyKey: "memory-test:embedding-retry-backfill",
      });
      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([]);

      const embedder = createTestEmbedder();
      const retryStore = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS + 1,
      });
      await expect(
        retryStore.createMemory({
          content: "Changed retry content should not be embedded.",
          idempotencyKey: "memory-test:embedding-retry-backfill",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: { id: created.memory.id },
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([
        expect.objectContaining({ memoryId: created.memory.id }),
      ]);
      expect(embedder.calls).toEqual([[content]]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("keeps memories searchable when embeddings have the wrong dimension", async () => {
    const fixture = await createMemoryFixture();

    try {
      const embedder = createTestEmbedder(
        { "Prefers lexical fallback for vector failures.": [1, 0, 0] },
        { dimensions: 3 },
      );
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        embedder,
        now: () => TEST_NOW_MS,
      });

      const created = await store.createMemory({
        content: "Prefers lexical fallback for vector failures.",
        idempotencyKey: "memory-test:embedding-dimension-mismatch",
      });

      await expect(
        memoryDb(fixture).select().from(memorySqlSchema.juniorMemoryEmbeddings),
      ).resolves.toEqual([]);
      await expect(
        store.searchMemories({ query: "lexical fallback" }),
      ).resolves.toEqual([expect.objectContaining({ id: created.memory.id })]);
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
        db: memoryDb(fixture),
        ...slackContext(),
      };
      const tools = {
        createMemory: createMemoryCreateTool(context),
        removeMemory: createMemoryRemoveTool(context),
        listMemories: createMemoryListTool(context),
        searchMemories: createMemorySearchTool(context),
      };

      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer terse status updates.",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: {
          content: "Prefers terse status updates.",
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
            type: "pub",
            teamId: "T123",
            channelId: "C123",
            messageTs: "1718800000.000000",
            threadTs: "1718800000.000000",
          },
        },
      });
      expect(reviewedRequests[0]).not.toHaveProperty("expiresAtMs");
      await expect(
        createMemoryCreateTool({
          ...context,
          agent: allowMemory("conversation"),
        }).execute(
          {
            content: "Incident notes live in Linear.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-conversation" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: {
          content: "Incident notes live in Linear.",
        },
      });

      await expect(
        tools.listMemories.execute({ limit: 10 }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "Incident notes live in Linear.",
          }),
          expect.objectContaining({
            content: "Prefers terse status updates.",
          }),
        ],
      });
      await expect(
        tools.searchMemories.execute({ query: "incident notes" }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "Incident notes live in Linear.",
          }),
        ],
      });

      const listResult = (await tools.listMemories.execute(
        { limit: 10 },
        {},
      )) as {
        memories: Array<{ content: string; id: string }>;
      };
      const personal = listResult.memories.find(
        (memory) => memory.content === "Prefers terse status updates.",
      );
      expect(personal).toBeDefined();
      await expect(
        tools.removeMemory.execute({ id: personal!.id.slice(0, 12) }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memory: {
          id: personal!.id,
          content: "Prefers terse status updates.",
        },
      });
      await expect(
        tools.searchMemories.execute({ query: "terse status" }, {}),
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
        }).execute(
          {
            content: "I prefer missing retry ids to fail.",
            expires_at: "never",
          },
          {},
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer invalid expiration to fail.",
            expires_at: "not-a-date",
          },
          { toolCallId: "tool-create-invalid-expiration" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
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
          content: "Prefers valid expiration to be stored.",
          expiresAtMs: Date.parse("2026-06-19T13:00:00+00:00"),
        },
      });
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer hidden fields to fail.",
            expires_at: "never",
            scope: "conversation",
          } as never,
          { toolCallId: "tool-create-hidden-field" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: " \n\t ",
            expires_at: "never",
          },
          { toolCallId: "tool-create-empty-content" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: rejectMemory,
          db: memoryDb(fixture),
          ...slackContext(),
        }).execute(
          {
            content: "I prefer rejected memories not to be stored.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-rejected" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        createMemoryCreateTool({
          agent: allowMemory("requester"),
          db: memoryDb(fixture),
          source: slackContext().source,
        }).execute(
          {
            content: "I prefer requester context failures to be visible.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-missing-requester" },
        ),
      ).rejects.toThrow(PluginToolInputError);
      await expect(
        tools.createMemory.execute(
          {
            content: "I prefer duplicate-safe retries.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        created: true,
        memory: { content: "Prefers duplicate-safe retries." },
      });
      await expect(
        tools.searchMemories.execute({ query: "duplicate-safe retries" }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "Prefers duplicate-safe retries.",
          }),
        ],
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("injects visible active memories into user prompt context", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const context = slackContext();
      const store = createMemoryStore(memoryDb(fixture), context, {
        now: () => nowMs,
      });
      const personal = await store.createMemory({
        content: "Prefers PR summaries with risks first.",
        idempotencyKey: "memory-test:recall-personal",
      });
      nowMs += 1;
      const conversation = await store.createConversationMemory({
        content: "Release notes live in Notion.",
        idempotencyKey: "memory-test:recall-conversation",
      });
      nowMs += 1;
      await store.createMemory({
        content: "Prefers PR summary obsolete wording.",
        expiresAtMs: TEST_NOW_MS + 1,
        idempotencyKey: "memory-test:recall-expired",
      });
      nowMs += 1;
      await createMemoryStore(
        memoryDb(fixture),
        slackContext({ userId: "U456" }),
        { now: () => nowMs },
      ).createMemory({
        content: "Prefers PR summary unrelated owner.",
        idempotencyKey: "memory-test:recall-other-user",
      });

      const plugin = createMemoryPlugin();
      const result = await plugin.hooks?.userPrompt?.({
        ...context,
        db: memoryDb(fixture),
        embedder: createTestEmbedder(),
        log: noopLogger,
        plugin: { name: "memory" },
        state: memoryState,
        text: "Draft a PR summary and mention release notes.",
      });

      expect(result).toEqual([
        {
          text: expect.stringContaining(personal.memory.content),
        },
      ]);
      const text = result?.[0]?.text ?? "";
      expect(text).toContain(conversation.memory.content);
      expect(text).not.toContain(personal.memory.id);
      expect(text).not.toContain(conversation.memory.id);
      expect(text).not.toContain("obsolete wording");
      expect(text).not.toContain("unrelated owner");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("skips user prompt memory recall when prompt text is blank", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      await createMemoryStore(memoryDb(fixture), context).createMemory({
        content: "Prefers PR summaries with risks first.",
        idempotencyKey: "memory-test:recall-blank",
      });

      const plugin = createMemoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          db: memoryDb(fixture),
          embedder: createTestEmbedder(),
          log: noopLogger,
          plugin: { name: "memory" },
          state: memoryState,
          text: "   ",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("uses prompt hook embeddings for semantic recall", async () => {
    const fixture = await createMemoryFixture();

    try {
      const context = slackContext();
      const memory = "Uses React hooks for UI state.";
      const query = "client rendering library";
      const embedder = createTestEmbedder({
        [memory]: unitEmbedding(1),
        [query]: unitEmbedding(1),
      });
      await createMemoryStore(memoryDb(fixture), context, {
        embedder,
        now: () => TEST_NOW_MS,
      }).createMemory({
        content: memory,
        idempotencyKey: "memory-test:recall-semantic",
      });

      const plugin = createMemoryPlugin();
      await expect(
        plugin.hooks?.userPrompt?.({
          ...context,
          db: memoryDb(fixture),
          embedder,
          log: noopLogger,
          plugin: { name: "memory" },
          state: memoryState,
          text: query,
        }),
      ).resolves.toEqual([
        {
          text: expect.stringContaining(memory),
        },
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("scopes tool create idempotency to the runtime source", async () => {
    const fixture = await createMemoryFixture();

    try {
      const firstTool = createMemoryCreateTool({
        agent: allowMemory("requester"),
        db: memoryDb(fixture),
        ...slackContext(),
      });
      const secondTool = createMemoryCreateTool({
        agent: allowMemory("requester"),
        db: memoryDb(fixture),
        ...slackContext({ threadTs: "1718800001.000000" }),
      });

      await expect(
        firstTool.execute(
          {
            content: "I prefer the first remembered fact.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });
      await expect(
        secondTool.execute(
          {
            content: "I prefer the second remembered fact.",
            expires_at: "never",
          },
          { toolCallId: "tool-create-reused-id" },
        ),
      ).resolves.toMatchObject({ created: true });

      await expect(
        createMemoryStore(memoryDb(fixture), slackContext()).listMemories({}),
      ).resolves.toEqual([
        expect.objectContaining({
          content: "Prefers the second remembered fact.",
        }),
        expect.objectContaining({
          content: "Prefers the first remembered fact.",
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
      const store = createMemoryStore(memoryDb(fixture), localContext(), {
        now: () => nowMs,
      });

      const personal = await store.createMemory({
        content: "Prefers local CLI memory checks.",
        idempotencyKey: "memory-test:local-personal",
      });
      nowMs = TEST_NOW_MS + 1;
      const conversation = await store.createConversationMemory({
        content: "Memory plugin validation is tracked in this local session.",
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
        memoryDb(fixture),
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
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

  it("recreates archived memories instead of resolving retries to hidden rows", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });

      const archived = await store.createMemory({
        content: "Prefers short deployment summaries.",
        idempotencyKey: "explicit-create-archived",
      });

      nowMs = TEST_NOW_MS + 1;
      await store.archiveMemory({ id: archived.memory.id });

      nowMs = TEST_NOW_MS + 2;
      const recreated = await store.createMemory({
        content: "Prefers short deployment summaries.",
        idempotencyKey: "explicit-create-archived",
      });
      expect(recreated).toMatchObject({
        created: true,
        memory: { content: archived.memory.content },
      });
      expect(recreated.memory.id).not.toBe(archived.memory.id);

      nowMs = TEST_NOW_MS + 3;
      await expect(
        store.createMemory({
          content: "Changed content with the recreated retry key.",
          idempotencyKey: "explicit-create-archived",
        }),
      ).resolves.toMatchObject({
        created: false,
        memory: {
          id: recreated.memory.id,
          content: recreated.memory.content,
        },
      });
      await expect(store.listMemories({})).resolves.toEqual([
        expect.objectContaining({ id: recreated.memory.id }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("treats expired memories as inactive for archive and recreate", async () => {
    const fixture = await createMemoryFixture();

    try {
      let nowMs = TEST_NOW_MS;
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });

      const expired = await store.createMemory({
        content: "Temporarily prefers quiet deploy reminders.",
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
        content: "Temporarily prefers quiet deploy reminders.",
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => nowMs,
      });
      const target = await store.createConversationMemory({
        content: "Release cutover rehearsal is durable.",
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
        now: () => TEST_NOW_MS,
      });

      await expect(
        store.createMemory({
          content: "Prefers short PR summaries.",
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
      const store = createMemoryStore(memoryDb(fixture), slackContext(), {
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
