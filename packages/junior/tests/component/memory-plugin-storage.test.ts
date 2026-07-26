import path from "node:path";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlugin,
  createMemoryStore,
  type MemoryDb,
} from "@sentry/junior-memory";
import {
  createSlackSource,
  defineJuniorPlugin,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { defineJuniorPlugins } from "@/plugins";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { bootstrapPluginSchemas } from "@/chat/plugins/migrations";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { closeDb } from "@/chat/db";
import { runUpgrade, runUpgradeMigrations } from "@/cli/upgrade";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

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
  await bootstrapPluginSchemas(fixture.sql, [
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
        bootstrapPluginSchemas(fixture.sql, [
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
        bootstrapPluginSchemas(fixture.sql, [
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
      const lines: string[] = [];
      const pluginSet = defineJuniorPlugins([
        createMemoryPlugin(),
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
        "Running Junior upgrade migrations...",
        "Running migration core-migrations...",
        `Finished migration core-migrations: scanned=${coreMigrationCount} migrated=${coreMigrationCount} existing=0 missing=0 skipped=0`,
        "Running migration plugin-migrations...",
        `Finished migration plugin-migrations: scanned=${memoryMigrationCount} migrated=${memoryMigrationCount} existing=0 missing=0`,
        "Junior upgrade complete.",
      ]);

      lines.length = 0;
      await runUpgrade({ info: (line) => lines.push(line) }, { pluginSet });
      expect(lines).toEqual([
        "Running Junior upgrade migrations...",
        "Running migration core-migrations...",
        `Finished migration core-migrations: scanned=${coreMigrationCount} migrated=0 existing=${coreMigrationCount} missing=0 skipped=0`,
        "Running migration plugin-migrations...",
        `Finished migration plugin-migrations: scanned=${memoryMigrationCount} migrated=0 existing=${memoryMigrationCount} missing=0`,
        "Junior upgrade complete.",
      ]);
    } finally {
      NEON.sql = undefined;
      await fixture.close();
    }
  }, 15_000);

  it("does not connect state for SQL-only migration journals", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      const getStateContext = vi.fn(async () => {
        throw new Error("SQL-only migrations must not connect state");
      });
      await expect(
        runUpgradeMigrations({
          getStateContext,
          io: { info: () => {} },
          pluginSet: defineJuniorPlugins([createMemoryPlugin()]),
        }),
      ).resolves.toHaveLength(2);
      expect(getStateContext).not.toHaveBeenCalled();
    } finally {
      NEON.sql = undefined;
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

        type: "priv",
      });
      const store = createMemoryStore(fixture.sql.db() as unknown as MemoryDb, {
        conversationId,
        actor,
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
        actor,
        workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
        source,
        userText: "remember memory plugin facts",
      });

      expect(tools).toHaveProperty("memory_createMemory");
      await expect(
        tools.memory_listMemories.execute!({}, {}),
      ).resolves.toMatchObject({
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
        tools.memory_searchMemories.execute!({ query: "personal recall" }, {}),
      ).resolves.toMatchObject({
        ok: true,
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
