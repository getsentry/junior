import path from "node:path";
import { readdirSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { readActorIdentity, resolveViewerUser } from "@/chat/plugins/viewer";
import { readPluginUserPage } from "@/chat/plugins/user-pages";
import { migratePluginsToSql } from "@/cli/upgrade/migrations/plugin-sql";
import { runUpgrade } from "@/cli/upgrade";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";
import {
  createSlackSource,
  defineJuniorPlugin,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";


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

afterEach(async () => {
  setPlugins([]);
  await closeDb();
  NEON.sql = undefined;
});

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
      await fixture.close();
    }
  }, 15_000);

  it("reads public memory everywhere and private memory only for its linked user", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const plugin = memoryPlugin();
    setPlugins([plugin]);
    NEON.sql = fixture.sql;

    try {
      await migrateSchema(fixture.sql);
      await migrateMemorySchema(fixture);
      const viewerConversationId = "slack:D123:1718800001.000000";
      const otherConversationId = "slack:D999:1718800002.000000";
      const conversationStore = createSqlStore(fixture.sql);
      await conversationStore.recordActivity({
        actor: {
          email: "memory-viewer@example.com",
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
        conversationId: viewerConversationId,
        destination: {
          channelId: "D123",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
        source: "slack",
        visibility: "private",
      });
      await conversationStore.recordActivity({
        actor: {
          email: "other-memory-viewer@example.com",
          platform: "slack",
          slackUserId: "U999",
          teamId: "T123",
        },
        conversationId: otherConversationId,
        destination: {
          channelId: "D999",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: Date.parse("2026-08-21T12:00:01.000Z"),
        source: "slack",
        visibility: "private",
      });
      const viewer = await resolveViewerUser("memory-viewer@example.com");
      const otherViewer = await resolveViewerUser(
        "other-memory-viewer@example.com",
      );
      const viewerConversation = await conversationStore.get({
        conversationId: viewerConversationId,
      });
      const otherConversation = await conversationStore.get({
        conversationId: otherConversationId,
      });
      expect(viewer).toBeDefined();
      expect(otherViewer).toBeDefined();
      expect(viewerConversation?.location).toBeDefined();
      expect(otherConversation?.location).toBeDefined();
      const publicSource = createSlackSource({
        teamId: "T123",
        channelId: "C123",
        messageTs: "1718800000.000000",
        visibility: "public",
      });
      const publicStore = createMemoryStore(
        fixture.sql.db() as unknown as MemoryDb,
        {
          conversationId: "slack:C123:1718800000.000000",
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          source: publicSource,
        },
      );
      const publicMemory = await publicStore.createConversationMemory({
        content: "Public runbooks live in Notion.",
        idempotencyKey: "component-public-memory",
        kind: "knowledge",
      });
      expect(publicMemory.memory).toMatchObject({
        scope: "public",
        subjectType: "conversation",
      });

      const privateSource = createSlackSource({
        teamId: "T123",
        channelId: "D123",
        messageTs: "1718800001.000000",
        visibility: "private",
      });
      const privateStore = createMemoryStore(
        fixture.sql.db() as unknown as MemoryDb,
        {
          conversationId: "slack:D123:1718800001.000000",
          locationId: viewerConversation!.location!.id,
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          source: privateSource,
          userId: viewer!.id,
        },
      );
      const privateMemory = await privateStore.createMemory({
        content: "Prefers terse status updates in this DM.",
        idempotencyKey: "component-private-memory",
        kind: "preference",
      });
      expect(privateMemory.memory).toMatchObject({
        scope: "private",
        subjectType: "user",
      });
      const otherPrivateStore = createMemoryStore(
        fixture.sql.db() as unknown as MemoryDb,
        {
          conversationId: otherConversationId,
          locationId: otherConversation!.location!.id,
          actor: { platform: "slack", teamId: "T123", userId: "U999" },
          source: createSlackSource({
            teamId: "T123",
            channelId: "D999",
            messageTs: "1718800002.000000",
            visibility: "private",
          }),
          userId: otherViewer!.id,
        },
      );
      const otherPrivateMemory = await otherPrivateStore.createMemory({
        content: "Only the other DM can read this.",
        idempotencyKey: "component-other-private-memory",
        kind: "knowledge",
      });
      expect(otherPrivateMemory.memory).toMatchObject({
        scope: "private",
        subjectType: "user",
      });
      await expect(
        fixture.sql.query<{ location_id: string | null }>(
          "SELECT location_id FROM junior_memory_memories WHERE id = $1",
          [privateMemory.memory.id],
        ),
      ).resolves.toEqual([{ location_id: viewerConversation!.location!.id }]);

      const viewerPage = await readPluginUserPage({
        email: "memory-viewer@example.com",
        pageId: "memories",
        pluginName: "memory",
        query: { limit: 25 },
      });
      expect(viewerPage?.records.map((record) => record.id)).toEqual(
        expect.arrayContaining([
          publicMemory.memory.id,
          privateMemory.memory.id,
        ]),
      );
      expect(viewerPage?.records.map((record) => record.id)).not.toContain(
        otherPrivateMemory.memory.id,
      );

      const sameUserContext = {
        conversationId: "slack:D999:1718800099.000000",
        locationId: otherConversation!.location!.id,
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "D999",
        },
        actor: { platform: "slack" as const, teamId: "T123", userId: "U123" },
        resolveActorIdentity: () =>
          readActorIdentity({
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          }),
        source: createSlackSource({
          teamId: "T123",
          channelId: "D999",
          messageTs: "1718800099.000000",
          visibility: "private",
        }),
        userText: "what should I remember?",
      };
      const sameUserTools = getPluginTools({
        ...sameUserContext,
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
      });
      await expect(
        sameUserTools.memory_listMemories.execute!({}, {}),
      ).resolves.toEqual({
        memories: [
          expect.objectContaining({ id: privateMemory.memory.id }),
          expect.objectContaining({ id: publicMemory.memory.id }),
        ],
        target: "listMemories",
      });

      const otherUserContext = {
        ...sameUserContext,
        conversationId: "slack:D123:1718800099.000000",
        locationId: viewerConversation!.location!.id,
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "D123",
        },
        actor: { platform: "slack" as const, teamId: "T123", userId: "U999" },
        resolveActorIdentity: () =>
          readActorIdentity({
            platform: "slack",
            teamId: "T123",
            userId: "U999",
          }),
        source: createSlackSource({
          teamId: "T123",
          channelId: "D123",
          messageTs: "1718800099.000000",
          visibility: "private",
        }),
      };
      const otherUserTools = getPluginTools({
        ...otherUserContext,
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
      });
      await expect(
        otherUserTools.memory_listMemories.execute!({}, {}),
      ).resolves.toEqual({
        memories: [
          expect.objectContaining({ id: otherPrivateMemory.memory.id }),
          expect.objectContaining({ id: publicMemory.memory.id }),
        ],
        target: "listMemories",
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("registers memory tools with runtime-provided plugin DB access", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    setPlugins([memoryPlugin()]);
    NEON.sql = fixture.sql;

    try {
      await migrateSchema(fixture.sql);
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
      const conversationStore = createSqlStore(fixture.sql);
      await conversationStore.recordActivity({
        actor: {
          email: "tool-viewer@example.com",
          platform: "slack",
          slackUserId: actor.userId,
          teamId: actor.teamId,
        },
        conversationId,
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
        source: "slack",
        visibility: "private",
      });
      const viewer = await resolveViewerUser("tool-viewer@example.com");
      const conversation = await conversationStore.get({ conversationId });
      expect(viewer).toBeDefined();
      expect(conversation?.location).toBeDefined();
      const store = createMemoryStore(
        // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
        (fixture.sql.db()) as MemoryDb,
        {
        conversationId,
        locationId: conversation!.location!.id,
        actor,
        source,
        userId: viewer!.id,
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
        locationId: conversation!.location!.id,
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
        resolveActorIdentity: () => readActorIdentity(actor),
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
            scope: "public",
          } as never,
          { toolCallId: "tool-create-personal" },
        ),
      ).rejects.toThrow(PluginToolInputError);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
