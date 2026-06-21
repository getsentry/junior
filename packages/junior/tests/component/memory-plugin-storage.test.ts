import path from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createMemoryPlugin, createMemoryStore } from "@sentry/junior-memory";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import { defineJuniorPlugins } from "@/plugins";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import {
  closeConfiguredPluginDb,
  createPluginDbForExecutor,
  migratePluginSchemas,
  readPluginMigrations,
} from "@/chat/plugins/db";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const NEON = vi.hoisted(() => ({
  executor: undefined as
    | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>["executor"]
    | undefined,
  originalJuniorDatabaseUrl: process.env.JUNIOR_DATABASE_URL,
}));

vi.hoisted(() => {
  process.env.JUNIOR_DATABASE_URL = "postgres://configured.example.test/neon";
});

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
    fixture.executor,
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

  it("registers memory tools with runtime-provided plugin DB access", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const previousPlugins = setPlugins([createMemoryPlugin()]);
    NEON.executor = fixture.executor;

    try {
      await migrateMemorySchema(fixture);
      const conversationId = "slack:C123:1718800000.000000";
      const requester = {
        platform: "slack" as const,
        teamId: "T123",
        userId: "U123",
      };
      const source = {
        platform: "slack" as const,
        teamId: "T123",
        channelId: "C123",
        messageTs: "1718800000.000000",
        threadTs: "1718800000.000000",
      };
      const store = createMemoryStore(
        createPluginDbForExecutor(fixture.executor),
        {
          conversationId,
          requester,
          source,
        },
      );
      await store.createMemory({
        content: "I prefer host-wired personal recall.",
        idempotencyKey: "component-memory-personal",
      });
      await store.createConversationMemory({
        content: "This thread tracks host-wired memory context.",
        idempotencyKey: "component-memory-conversation",
      });

      const tools = getPluginTools({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
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
          },
          { toolCallId: "tool-create-personal" },
        ),
      ).rejects.toThrow(PluginToolInputError);
    } finally {
      setPlugins(previousPlugins);
      await closeConfiguredPluginDb();
      NEON.executor = undefined;
      await fixture.close();
    }
  }, 15_000);
});
