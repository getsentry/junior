import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackSource,
  defineJuniorPlugin,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { createMemoryFeature } from "@/chat/memory/feature";
import { createMemoryStore, type MemoryDb } from "@/chat/memory/store";
import { defineJuniorPlugins, pluginCatalogConfigFromEnv } from "@/plugins";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { setCoreFeatures } from "@/chat/plugins/core-features";
import { closeDb } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { readActorIdentity, resolveViewerUser } from "@/chat/plugins/viewer";
import { readPluginUserPage } from "@/chat/plugins/user-pages";
import { createEmptyJuniorSqlFixture } from "../../fixtures/sql";

const NEON = vi.hoisted(() => ({
  sql: undefined as
    | Awaited<ReturnType<typeof createEmptyJuniorSqlFixture>>["sql"]
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
  setCoreFeatures([]);
  vi.restoreAllMocks();
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

async function recordPrivateConversation(
  fixture: Awaited<ReturnType<typeof createEmptyJuniorSqlFixture>>,
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

describe("memory core feature host wiring", () => {
  it("stops startup while a plugin set still names the removed Memory plugin", () => {
    const removed = "@sentry/junior-memory was removed";
    // The last published `memoryPlugin()` returns this registration.
    const publishedMemoryPlugin = defineJuniorPlugin({
      manifest: {
        description: "Long-term Junior memory storage and recall",
        displayName: "Memory",
        name: "memory",
      },
      packageName: "@sentry/junior-memory",
    });

    expect(() => defineJuniorPlugins([publishedMemoryPlugin])).toThrow(removed);
    expect(() => defineJuniorPlugins(["@sentry/junior-memory"])).toThrow(
      removed,
    );
    expect(() =>
      pluginCatalogConfigFromEnv({
        JUNIOR_PLUGIN_PACKAGES: JSON.stringify(["@sentry/junior-memory"]),
      }),
    ).toThrow(removed);
  });

  it("reads public memory everywhere and private memory only for its User", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    setCoreFeatures([createMemoryFeature()]);
    NEON.sql = fixture.sql;

    try {
      await migrateSchema(fixture.sql);
      const db: MemoryDb = fixture.sql.db();
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

  it("registers memory tools with runtime-provided core DB access", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    setCoreFeatures([createMemoryFeature()]);
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
      const store = createMemoryStore(fixture.sql.db(), {
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
        userText: "remember memory facts",
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
