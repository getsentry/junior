import path from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlugin,
  createMemoryStore,
  type MemoryDb,
} from "@sentry/junior-memory";
import {
  createSlackSource,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { defineJuniorPlugins } from "@/plugins";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { migratePluginSchemas, readPluginMigrations } from "@/chat/plugins/db";
import { closeDb } from "@/chat/db";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const NEON = vi.hoisted(() => ({
  sql: undefined as
    | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>["sql"]
    | undefined,
  originalJuniorDatabaseUrl: process.env.JUNIOR_DATABASE_URL,
}));

vi.hoisted(() => {
  process.env.JUNIOR_DATABASE_URL = "postgres://configured.example.test/neon";
});

vi.mock("@/chat/sql/executor", () => ({
  createJuniorSqlExecutor: vi.fn(() => {
    if (!NEON.sql) {
      throw new Error("Missing test SQL executor");
    }
    return {
      db: NEON.sql.db.bind(NEON.sql),
      execute: NEON.sql.execute.bind(NEON.sql),
      query: NEON.sql.query.bind(NEON.sql),
      transaction: NEON.sql.transaction.bind(NEON.sql),
      withLock: NEON.sql.withLock.bind(NEON.sql),
      close: async () => {},
    };
  }),
}));

vi.mock("@/chat/pi/client", () => ({
  completeObject: vi.fn(async () => ({
    object: {
      canonicalFact: "Prefers terse status updates.",
      decision: "store",
      expiresAtMs: null,
      kind: "preference",
    },
  })),
  embedTexts: vi.fn(async ({ texts }: { texts: string[] }) => ({
    dimensions: 1,
    model: "test-embedding-model",
    provider: "test-provider",
    vectors: texts.map(() => [1]),
  })),
  resolveGatewayModel: vi.fn((modelId: string) => modelId),
}));

afterAll(() => {
  if (NEON.originalJuniorDatabaseUrl === undefined) {
    delete process.env.JUNIOR_DATABASE_URL;
    return;
  }
  process.env.JUNIOR_DATABASE_URL = NEON.originalJuniorDatabaseUrl;
});

function memoryMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-memory/migrations");
}

async function migrateMemorySchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  await migratePluginSchemas(
    fixture.sql,
    readPluginMigrations({
      dir: memoryMigrationsDir(),
      pluginName: "memory",
    }),
  );
}

describe("memory plugin host wiring", () => {
  it("applies packaged migrations through plugin discovery", async () => {
    const stateAdapter = createMemoryState();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      const migrationCount = readPluginMigrations({
        dir: memoryMigrationsDir(),
        pluginName: "memory",
      }).length;
      await expect(
        migratePluginsToSql({
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([createMemoryPlugin()]),
          sqlDatabaseUrl: "postgres://configured.example.test/neon",
          stateAdapter,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: migrationCount,
        missing: 0,
        scanned: migrationCount,
      });

      await expect(
        fixture.sql.query<{ table_name: string }>(
          `
SELECT table_name
FROM information_schema.tables
WHERE table_name = 'junior_memory_memories'
`,
        ),
      ).resolves.toEqual([{ table_name: "junior_memory_memories" }]);
    } finally {
      NEON.sql = undefined;
      await stateAdapter.disconnect();
      await fixture.close();
    }
  }, 15_000);

  it("registers memory tools with runtime-provided plugin DB access", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const previousPlugins = setPlugins([createMemoryPlugin()]);
    NEON.sql = fixture.sql;

    try {
      await migrateMemorySchema(fixture);
      const conversationId = "slack:C123:1718800000.000000";
      const requester = {
        platform: "slack" as const,
        teamId: "T123",
        userId: "U123",
      };
      const source = createSlackSource({
        teamId: "T123",
        channelId: "C123",
        messageTs: "1718800000.000000",
        threadTs: "1718800000.000000",
      });
      const store = createMemoryStore(fixture.sql.db() as unknown as MemoryDb, {
        conversationId,
        requester,
        source,
      });
      await store.createMemory({
        content: "I prefer host-wired personal recall.",
        idempotencyKey: "component-memory-personal",
        kind: "preference",
      });
      await store.createConversationMemory({
        content: "This thread tracks host-wired memory context.",
        idempotencyKey: "component-memory-conversation",
        kind: "knowledge",
      });

      const tools = getPluginTools({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        requester,
        sandbox: {} as Parameters<typeof getPluginTools>[0]["sandbox"],
        source,
        userText: "remember memory plugin facts",
      });

      expect(tools).toHaveProperty("createMemory");
      await expect(tools.listMemories.execute!({}, {})).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "This thread tracks host-wired memory context.",
          }),
          expect.objectContaining({
            content: "I prefer host-wired personal recall.",
          }),
        ],
      });
      await expect(
        tools.searchMemories.execute!({ query: "personal recall" }, {}),
      ).resolves.toMatchObject({
        ok: true,
        memories: [
          expect.objectContaining({
            content: "I prefer host-wired personal recall.",
          }),
        ],
      });
      await expect(
        tools.createMemory.execute!(
          {
            content: "I prefer terse status updates.",
            scope: "conversation",
          } as never,
          { toolCallId: "tool-create-personal" },
        ),
      ).rejects.toThrow(PluginToolInputError);
    } finally {
      setPlugins(previousPlugins);
      await closeDb();
      NEON.sql = undefined;
      await fixture.close();
    }
  }, 15_000);
});
