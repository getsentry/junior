import path from "node:path";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  memoryPlugin,
  createMemoryStore,
  type MemoryDb,
} from "@sentry/junior-memory";
import { defineJuniorPlugins } from "@/plugins";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { closeDb } from "@/chat/db";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { runUpgrade } from "@/cli/upgrade";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";
import {
  createSlackSource,
  defineJuniorPlugin,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";


/** Test-only bridge for intentionally incomplete doubles. */
function asTestDouble<T>(value: unknown): T {
  return value as T;
}

const NEON = vi.hoisted(() => ({
  sql: undefined as
    | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>["sql"]
    | undefined,
  originalDatabaseUrl: process.env.DATABASE_URL,
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://configured.example.test/neon";
});

vi.mock("@/db/executor", () => ({
  createJuniorSqlExecutor: vi.fn(() => {
    if (!NEON.sql) {
      throw new Error("Missing test SQL executor");
    }
    return {
      db: NEON.sql.db.bind(NEON.sql),
      execute: NEON.sql.execute.bind(NEON.sql),
      query: NEON.sql.query.bind(NEON.sql),
      migrate: NEON.sql.migrate.bind(NEON.sql),
      transaction: NEON.sql.transaction.bind(NEON.sql),
      withLock: NEON.sql.withLock.bind(NEON.sql),
      withMigrationLock: NEON.sql.withMigrationLock.bind(NEON.sql),
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
  if (NEON.originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = NEON.originalDatabaseUrl;
  }
});

function memoryMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-memory/migrations");
}

function memoryMigrationFiles(): string[] {
  return readdirSync(memoryMigrationsDir())
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

async function migrateMemorySchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  await migratePluginSchemas(fixture.sql, [
    {
      dir: memoryMigrationsDir(),
      pluginName: "memory",
    },
  ]);
}

describe("memory plugin host wiring", () => {
  it("adopts exact legacy migration hashes without replaying them", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrations = readMigrationFiles({
      migrationsFolder: memoryMigrationsDir(),
    });
    const migrationFiles = memoryMigrationFiles();
    expect(migrationFiles).toHaveLength(migrations.length);

    try {
      await migrateMemorySchema(fixture);
      const [migrationTable] = await fixture.sql.query<{ tablename: string }>(`
SELECT tablename
FROM pg_tables
WHERE schemaname = 'drizzle'
  AND tablename LIKE '__drizzle_memory_%'
`);
      expect(migrationTable).toBeDefined();
      await fixture.sql.execute(
        `DROP TABLE drizzle.${migrationTable!.tablename}`,
      );
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      for (const [index, migration] of migrations.entries()) {
        await fixture.sql.execute(
          `INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)`,
          [`plugin:memory/${migrationFiles[index]}`, migration.hash],
        );
      }

      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: memoryMigrationsDir(),
            pluginName: "memory",
          },
        ]),
      ).resolves.toEqual({
        existing: migrations.length,
        migrated: 0,
        scanned: migrations.length,
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not adopt an unknown memory legacy checksum", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationCount = readMigrationFiles({
      migrationsFolder: memoryMigrationsDir(),
    }).length;
    const [baselineFile] = memoryMigrationFiles();
    expect(baselineFile).toBeDefined();

    try {
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      await fixture.sql.execute(
        `INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)`,
        [`plugin:memory/${baselineFile}`, "unknown-memory-checksum"],
      );

      await expect(
        migratePluginSchemas(fixture.sql, [
          {
            dir: memoryMigrationsDir(),
            pluginName: "memory",
          },
        ]),
      ).resolves.toEqual({
        existing: 0,
        migrated: migrationCount,
        scanned: migrationCount,
      });
    } finally {
      await fixture.close();
    }
  });

  it("applies packaged migrations through plugin discovery", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      const migrationCount = readMigrationFiles({
        migrationsFolder: memoryMigrationsDir(),
      }).length;
      await expect(
        migratePluginsToSql({
          pluginSet: defineJuniorPlugins([memoryPlugin()]),
          sqlExecutor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: migrationCount,
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

      await expect(
        fixture.sql.query<{ extname: string }>(
          "SELECT extname FROM pg_extension WHERE extname = 'btree_gin'",
        ),
      ).resolves.toEqual([{ extname: "btree_gin" }]);

      await expect(
        fixture.sql.query<{ is_generated: string }>(
          `
SELECT is_generated
FROM information_schema.columns
WHERE table_name = 'junior_memory_memories'
  AND column_name = 'search_vector'
`,
        ),
      ).resolves.toEqual([{ is_generated: "ALWAYS" }]);

      const [searchIndex] = await fixture.sql.query<{ indexdef: string }>(`
SELECT indexdef
FROM pg_indexes
WHERE indexname = 'junior_memory_memories_search_idx'
`);
      expect(searchIndex?.indexdef).toContain(
        "USING gin (scope, scope_key, search_vector)",
      );
    } finally {
      NEON.sql = undefined;
      await fixture.close();
    }
  }, 15_000);

  it("reports core and nonempty plugin migration journals", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      const coreMigrationCount = readMigrationFiles({
        migrationsFolder: path.resolve(process.cwd(), "migrations"),
      }).length;
      const memoryMigrationCount = readMigrationFiles({
        migrationsFolder: memoryMigrationsDir(),
      }).length;
      const totalMigrationCount = coreMigrationCount + memoryMigrationCount;
      const lines: string[] = [];
      const pluginSet = defineJuniorPlugins([
        memoryPlugin(),
        defineJuniorPlugin({
          manifest: {
            description: "Plugin without SQL migrations",
            displayName: "Empty",
            name: "empty",
          },
        }),
      ]);

      await runUpgrade({ info: (line) => lines.push(line) }, { pluginSet });
      expect(lines).toEqual([
        "Checking database migrations...",
        `  junior: applied ${coreMigrationCount} migrations (${coreMigrationCount} total)`,
        `  junior-memory: applied ${memoryMigrationCount} migrations (${memoryMigrationCount} total)`,
        `Applied ${totalMigrationCount} migrations (${totalMigrationCount} total).`,
      ]);

      lines.length = 0;
      await runUpgrade({ info: (line) => lines.push(line) }, { pluginSet });
      expect(lines).toEqual([
        "Checking database migrations...",
        `  junior: up to date (${coreMigrationCount} migrations)`,
        `  junior-memory: up to date (${memoryMigrationCount} migrations)`,
        `Database is up to date (${totalMigrationCount} migrations).`,
      ]);
    } finally {
      NEON.sql = undefined;
      await fixture.close();
    }
  }, 15_000);

  it("registers memory tools with runtime-provided plugin DB access", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const previousPlugins = setPlugins([memoryPlugin()]);
    NEON.sql = fixture.sql;

    try {
      await migrateMemorySchema(fixture);
      const conversationId = "slack:C123:1718800000.000000";
      const actor = {
        platform: "slack" as const,
        teamId: "T123",
        userId: "U123",
      };
      const source = createSlackSource({
        teamId: "T123",
        channelId: "C123",
        messageTs: "1718800000.000000",
        threadTs: "1718800000.000000",

        visibility: "private",
      });
      const store = createMemoryStore(
        asTestDouble<MemoryDb>(fixture.sql.db()),
        {
          conversationId,
          actor,
          source,
        },
      );
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
        actor,
        workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
        source,
        userText: "remember memory plugin facts",
      });

      expect(tools).toHaveProperty("memory_createMemory");
      await expect(
        tools.memory_listMemories.execute!({}, {}),
      ).resolves.toMatchObject({
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
        tools.memory_searchMemories.execute!({ query: "personal recall" }, {}),
      ).resolves.toMatchObject({
        memories: [
          expect.objectContaining({
            content: "I prefer host-wired personal recall.",
          }),
        ],
      });
      await expect(
        tools.memory_createMemory.execute!(
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
