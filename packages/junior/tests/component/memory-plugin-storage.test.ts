import path from "node:path";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryDb } from "@/chat/memory/store";
import { createMemoryRegistration as memoryPlugin } from "@/chat/memory/registration";
import { memoryRuntimeRegistrations } from "@/chat/memory/runtime";
import { defineJuniorPlugins } from "@/plugins";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { closeDb } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { readActorIdentity, resolveViewerUser } from "@/chat/plugins/viewer";
import { readPluginUserPage } from "@/chat/plugins/user-pages";
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
      reason: null,
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

function coreMigrationsDir(): string {
  return path.resolve(process.cwd(), "migrations");
}

function copyPreMemoryCoreMigrations(): string {
  const source = coreMigrationsDir();
  const destination = mkdtempSync(
    path.join(tmpdir(), "junior-pre-memory-core-"),
  );
  mkdirSync(path.join(destination, "meta"));
  const journal = JSON.parse(
    readFileSync(path.join(source, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const adoption = journal.entries.find((entry) => {
    const sql = readFileSync(path.join(source, `${entry.tag}.sql`), "utf8");
    return sql.includes("Adopt the former Memory plugin tables");
  });
  if (!adoption) {
    throw new Error("Memory adoption migration not found");
  }
  const entries = journal.entries.filter((entry) => entry.idx < adoption.idx);
  writeFileSync(
    path.join(destination, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    copyFileSync(
      path.join(source, `${entry.tag}.sql`),
      path.join(destination, `${entry.tag}.sql`),
    );
  }
  return destination;
}

async function createLegacyMemoryTable(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
): Promise<void> {
  await fixture.sql.execute(`
CREATE TABLE junior_memory_memories (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT,
  content TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  source_key TEXT NOT NULL,
  idempotency_key TEXT,
  observed_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  superseded_at_ms BIGINT,
  superseded_by_id TEXT,
  archived_at_ms BIGINT,
  archive_reason TEXT
)
`);
}

async function recordPrivateConversation(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
  args: {
    channelId: string;
    conversationId: string;
    email: string;
    nowMs: number;
    userId: string;
  },
) {
  const conversations = createSqlStore(fixture.sql);
  await conversations.recordActivity({
    actor: {
      email: args.email,
      platform: "slack",
      slackUserId: args.userId,
      teamId: "T123",
    },
    conversationId: args.conversationId,
    destination: {
      channelId: args.channelId,
      platform: "slack",
      teamId: "T123",
    },
    nowMs: args.nowMs,
    source: "slack",
    visibility: "private",
  });
  const [user, conversation] = await Promise.all([
    resolveViewerUser(args.email),
    conversations.get({ conversationId: args.conversationId }),
  ]);
  if (!user || !conversation?.location) {
    throw new Error("Test Conversation did not resolve its User and Location");
  }
  return { locationId: conversation.location.id, user };
}

function memoryToolsFor(args: {
  channelId: string;
  conversationId: string;
  locationId: string;
  userId: string;
}) {
  const actor = {
    platform: "slack" as const,
    teamId: "T123",
    userId: args.userId,
  };
  return getPluginTools({
    actor,
    conversationId: args.conversationId,
    destination: {
      channelId: args.channelId,
      platform: "slack",
      teamId: "T123",
    },
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    locationId: args.locationId,
    resolveActorIdentity: () => readActorIdentity(actor),
    source: createSlackSource({
      channelId: args.channelId,
      messageTs: "1718800099.000000",
      teamId: "T123",
      visibility: "private",
    }),
    userText: "what should I remember?",
    workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
  });
}

describe("memory plugin host wiring", () => {
  it("adopts deployed Memory rows into the core schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const oldCoreMigrations = copyPreMemoryCoreMigrations();

    try {
      await fixture.sql.migrate({
        migrationsFolder: oldCoreMigrations,
        migrationsTable: "__drizzle_junior_core",
      });
      await createLegacyMemoryTable(fixture);
      await fixture.sql.execute(
        `INSERT INTO junior_memory_memories (
          id, scope, scope_key, type, subject_type, subject_key, content,
          source_platform, source_key, idempotency_key, observed_at_ms, created_at_ms
        ) VALUES ($1, 'conversation', 'slack:T123:C123:1718800000.000000',
          'task', 'conversation', 'slack:T123:C123:1718800000.000000', $2,
          'slack', 'slack:T123:C123:1718800000.000000', $3, $4, $4)`,
        [
          "legacy-memory",
          "Use the deploy runbook.",
          "legacy-memory-key",
          Date.parse("2026-08-21T12:00:00.000Z"),
        ],
      );

      await migrateSchema(fixture.sql);

      await expect(
        fixture.sql.query<{
          conversationId: string | null;
          id: string;
          kind: string;
          scope: string;
          scopeKey: string;
        }>(
          `SELECT id, type AS kind, scope, scope_key AS "scopeKey",
                  conversation_id AS "conversationId"
           FROM junior_memory_memories WHERE id = $1`,
          ["legacy-memory"],
        ),
      ).resolves.toEqual([
        {
          conversationId: "slack:C123:1718800000.000000",
          id: "legacy-memory",
          kind: "procedure",
          scope: "public",
          scopeKey: "public",
        },
      ]);
      await expect(
        fixture.sql.query<{ isGenerated: string }>(
          `SELECT is_generated AS "isGenerated"
           FROM information_schema.columns
           WHERE table_name = 'junior_memory_memories'
             AND column_name = 'search_vector'`,
        ),
      ).resolves.toEqual([{ isGenerated: "ALWAYS" }]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reports Memory in the core migration journal", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    NEON.sql = fixture.sql;

    try {
      const coreMigrationCount = readMigrationFiles({
        migrationsFolder: coreMigrationsDir(),
      }).length;
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
        `Applied ${coreMigrationCount} migrations (${coreMigrationCount} total).`,
      ]);

      lines.length = 0;
      await runUpgrade({ info: (line) => lines.push(line) }, { pluginSet });
      expect(lines).toEqual([
        "Checking database migrations...",
        `  junior: up to date (${coreMigrationCount} migrations)`,
        `Database is up to date (${coreMigrationCount} migrations).`,
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reads public memory everywhere and private memory only for its User", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    setPlugins(memoryRuntimeRegistrations([]));
    NEON.sql = fixture.sql;

    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db() as MemoryDb;
      const viewerConversationId = "slack:D123:1718800001.000000";
      const viewer = await recordPrivateConversation(fixture, {
        channelId: "D123",
        conversationId: viewerConversationId,
        email: "memory-viewer@example.com",
        nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
        userId: "U123",
      });
      const publicMemory = await createMemoryStore(db, {
        conversationId: "slack:C123:1718800000.000000",
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          messageTs: "1718800000.000000",
          visibility: "public",
        }),
      }).createConversationMemory({
        content: "Public runbooks live in Notion.",
        idempotencyKey: "component-public-memory",
        kind: "knowledge",
      });
      const privateMemory = await createMemoryStore(db, {
        conversationId: viewerConversationId,
        locationId: viewer.locationId,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        source: createSlackSource({
          teamId: "T123",
          channelId: "D123",
          messageTs: "1718800001.000000",
          visibility: "private",
        }),
        userId: viewer.user.id,
      }).createMemory({
        content: "Prefers terse status updates in this DM.",
        idempotencyKey: "component-private-memory",
        kind: "preference",
      });
      const otherPrivateMemory = await createMemoryStore(db, {
        conversationId: viewerConversationId,
        locationId: viewer.locationId,
        actor: { platform: "slack", teamId: "T123", userId: "U999" },
        source: createSlackSource({
          teamId: "T123",
          channelId: "D123",
          messageTs: "1718800002.000000",
          visibility: "private",
        }),
        userId: "other-user",
      }).createMemory({
        content: "Only the other User can read this.",
        idempotencyKey: "component-other-private-memory",
        kind: "knowledge",
      });
      await expect(
        fixture.sql.query<{ location_id: string | null }>(
          "SELECT location_id FROM junior_memory_memories WHERE id = $1",
          [privateMemory.memory.id],
        ),
      ).resolves.toEqual([{ location_id: viewer.locationId }]);

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

      await expect(
        memoryToolsFor({
          channelId: "D999",
          conversationId: "slack:D999:1718800099.000000",
          locationId: "other-location",
          userId: "U123",
        }).memory_listMemories.execute!({}, {}),
      ).resolves.toEqual({
        memories: [
          expect.objectContaining({ id: privateMemory.memory.id }),
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
    setPlugins(memoryRuntimeRegistrations([]));
    NEON.sql = fixture.sql;

    try {
      await migrateSchema(fixture.sql);
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
      const userContext = await recordPrivateConversation(fixture, {
        channelId: "C123",
        conversationId,
        email: "tool-viewer@example.com",
        nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
        userId: actor.userId,
      });
      const store = createMemoryStore(fixture.sql.db() as MemoryDb, {
        conversationId,
        locationId: userContext.locationId,
        actor,
        source,
        userId: userContext.user.id,
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
        locationId: userContext.locationId,
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
