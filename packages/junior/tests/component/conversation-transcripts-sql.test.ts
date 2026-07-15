import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import {
  conversationEventDataSchema,
  conversationEventSchema,
} from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import { purgeConversation } from "@/chat/conversations/retention";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import {
  persistConversationCompactions,
  projectVisibleConversationCompactions,
} from "@/chat/conversations/visible-compactions";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversationMessages,
  juniorConversations,
} from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  loadConnectedMcpProviders,
  openConversationProjection,
  recordMcpProviderConnected,
} from "@/chat/conversations/projection";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const CHILD_CONVERSATION_ID = "advisor:child-1";
const coreMigrationCount = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
}).length;

async function listMessageRows(
  fixture: LocalJuniorSqlFixture,
  conversationId: string,
) {
  return fixture.sql
    .db()
    .select()
    .from(juniorConversationMessages)
    .where(eq(juniorConversationMessages.conversationId, conversationId))
    .orderBy(
      asc(juniorConversationMessages.createdAt),
      asc(juniorConversationMessages.messageId),
    );
}

it("accepts legacy markers and validates current profile names", () => {
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "initial",
      modelProfile: "standard",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "handoff",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "Fast!",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "coding",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
});

it("rejects unknown Junior event fields while retaining opaque message fields", () => {
  expect(
    conversationEventDataSchema.safeParse({
      type: "visible_message_recorded",
      messageId: "m1",
      role: "user",
      text: "hello",
      unknown: true,
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "visible_message_metadata_updated",
      messageId: "m1",
      meta: { imagesHydrated: true },
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "mcp_provider_connected",
      provider: "github",
      unknown: true,
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "visible_context_compacted",
      compactions: [
        {
          coveredMessageIds: ["m1"],
          createdAtMs: 1_000,
          id: "compaction-1",
          summary: "Earlier context",
          unknown: true,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "message",
      message: { role: "", providerOwnedField: true },
    }).success,
  ).toBe(true);
});

it("validates strict privacy-safe turn lifecycle event shapes", () => {
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_started",
      turnId: "turn-1",
      inputMessageIds: ["message-1"],
      surface: "internal",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_completed",
      turnId: "turn-1",
      outcome: "no_reply",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_failed",
      turnId: "turn-1",
      failureCode: "model_execution_failed",
      eventId: "0123456789abcdef0123456789abcdef",
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_started",
      turnId: "turn-1",
      inputMessageIds: ["message-1", "message-1"],
      surface: "internal",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_failed",
      turnId: "turn-1",
      failureCode: "model_execution_failed",
      eventId: "https://errors.invalid/raw-error-sentinel",
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "turn_failed",
      turnId: "turn-1",
      failureCode: "provider_error: raw-error-sentinel",
      providerError: { message: "raw-error-sentinel" },
    }).success,
  ).toBe(false);
});

it("rejects unsupported conversation event schema versions", () => {
  expect(
    conversationEventSchema.safeParse({
      schemaVersion: 2,
      seq: 0,
      contextEpoch: 0,
      createdAtMs: 1_000,
      data: { type: "mcp_provider_connected", provider: "github" },
    }).success,
  ).toBe(false);
});

it("rejects epoch markers through the ordinary append boundary", async () => {
  await expect(
    getConversationEventStore().append("local:test:invalid-marker-append", [
      {
        data: {
          type: "context_epoch_started",
          reason: "compaction",
        },
        createdAtMs: 1,
      } as never,
    ]),
  ).rejects.toThrow("Invalid input");
});

it("rejects incomplete markers through the epoch boundary", async () => {
  const conversationId = "local:test:invalid-marker-start";
  await expect(
    getConversationEventStore().startEpoch(conversationId, {
      reason: "handoff",
      modelProfile: "handoff",
      messages: [],
    } as never),
  ).rejects.toThrow("Invalid input");
  await expect(
    getConversationEventStore().loadHistory(conversationId),
  ).resolves.toEqual([]);
});

it("opens an explicit initial epoch without dropping earlier host facts", async () => {
  const conversationId = "local:test:host-fact-before-model";
  await recordMcpProviderConnected({ conversationId, provider: "linear" });

  await expect(
    openConversationProjection({
      conversationId,
      modelId: "openai/gpt-5.4",
    }),
  ).resolves.toMatchObject({
    messages: [],
    modelProfile: "standard",
    modelId: "openai/gpt-5.4",
  });
  await expect(loadConnectedMcpProviders({ conversationId })).resolves.toEqual([
    "linear",
  ]);
  expect(await getConversationEventStore().loadHistory(conversationId)).toEqual(
    [
      expect.objectContaining({
        contextEpoch: 0,
        data: expect.objectContaining({ type: "mcp_provider_connected" }),
      }),
      expect.objectContaining({
        contextEpoch: 0,
        data: {
          type: "context_epoch_started",
          reason: "initial",
          modelProfile: "standard",
          modelId: "openai/gpt-5.4",
        },
      }),
    ],
  );
});

async function seedConversation(
  fixture: LocalJuniorSqlFixture,
  conversationId: string,
  parentConversationId?: string,
): Promise<void> {
  await fixture.sql
    .db()
    .insert(juniorConversations)
    .values(
      buildJuniorSqlConversation({
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
      }),
    );
}

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 0,
  };
}

describe("conversation transcript SQL stores", () => {
  it("persists visible-context compaction snapshots in conversation history", async () => {
    const events = getConversationEventStore();
    const conversation = coerceThreadConversationState({});
    conversation.compactions = [
      {
        id: "compaction-1",
        summary: "Earlier visible context",
        coveredMessageIds: ["m1", "m2"],
        createdAtMs: 2_000,
      },
    ];

    await persistConversationCompactions({
      conversation,
      conversationId: CONVERSATION_ID,
    });
    await persistConversationCompactions({
      conversation,
      conversationId: CONVERSATION_ID,
    });

    const history = await events.loadHistory(CONVERSATION_ID);
    expect(projectVisibleConversationCompactions(history)).toEqual(
      conversation.compactions,
    );
    expect(history).toHaveLength(1);
  });

  it("applies Drizzle migrations idempotently", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await migrateSchema(fixture.sql);

      const [applied] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );
      expect(applied?.count).toBe(coreMigrationCount);
    } finally {
      await fixture.close();
    }
  });

  it("assigns sequential seq and fences conflicting appends loudly", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("one") },
          createdAtMs: 1_000,
        },
        {
          data: { type: "message", message: userMessage("two") },
          createdAtMs: 2_000,
        },
      ]);
      await store.append(CONVERSATION_ID, [
        {
          data: { type: "mcp_provider_connected", provider: "github" },
          createdAtMs: 3_000,
        },
      ]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.seq)).toEqual([0, 1, 2]);
      expect(history.map((event) => event.schemaVersion)).toEqual([1, 1, 1]);
      expect(history.map((event) => event.data.type)).toEqual([
        "message",
        "message",
        "mcp_provider_connected",
      ]);

      // A writer that lost its lease and reuses seq 0 must fail on the PK.
      await expect(
        fixture.sql
          .db()
          .insert(juniorConversationEvents)
          .values({
            conversationId: CONVERSATION_ID,
            seq: 0,
            contextEpoch: 0,
            schemaVersion: 1,
            type: "message",
            role: "user",
            payload: { message: userMessage("clobber") },
            createdAt: new Date(4_000),
          }),
      ).rejects.toThrow(Error);
    } finally {
      await fixture.close();
    }
  });

  it("persists only the first conflicting terminal turn event", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      const lifecycle = new ConversationTurnLifecycleService(store);
      await lifecycle.start({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        inputMessageIds: ["message-1"],
        surface: "internal",
        turnId: "turn-conflict",
      });

      await Promise.all([
        lifecycle.complete({
          conversationId: CONVERSATION_ID,
          createdAtMs: 2_000,
          outcome: "success",
          turnId: "turn-conflict",
        }),
        lifecycle.fail({
          conversationId: CONVERSATION_ID,
          createdAtMs: 2_000,
          failureCode: "delivery_failed",
          turnId: "turn-conflict",
        }),
      ]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.data.type)).toEqual([
        "turn_started",
        expect.stringMatching(/^turn_(?:completed|failed)$/),
      ]);
      expect(
        history.filter((event) => event.idempotencyKey?.endsWith(":terminal")),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("replaces NUL characters before persisting conversation events", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: {
            type: "message",
            message: userMessage("before\u0000after and literal \\u0000"),
          },
          createdAtMs: 1_000,
        },
      ]);

      expect((await store.loadHistory(CONVERSATION_ID))[0]?.data).toMatchObject(
        {
          type: "message",
          message: {
            content: [
              { text: "before after and literal \\u0000", type: "text" },
            ],
          },
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("returns only the highest epoch from loadCurrentEpoch", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("epoch0-a") },
          createdAtMs: 1_000,
        },
        {
          data: { type: "message", message: userMessage("epoch0-b") },
          createdAtMs: 2_000,
        },
      ]);
      await store.startEpoch(CONVERSATION_ID, {
        modelId: "test/model",
        reason: "compaction",
        modelProfile: "standard",
        messages: [
          { message: userMessage("epoch1-summary"), createdAtMs: 3_000 },
        ],
      });

      const current = await store.loadCurrentEpoch(CONVERSATION_ID);
      expect(current.map((event) => event.contextEpoch)).toEqual([1, 1]);
      expect(current.map((event) => event.data.type)).toEqual([
        "context_epoch_started",
        "message",
      ]);
      expect(current.map((event) => event.seq)).toEqual([2, 3]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.contextEpoch)).toEqual([0, 0, 1, 1]);
    } finally {
      await fixture.close();
    }
  });

  it("round trips provider-neutral isolated subagent history", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      const data = {
        type: "subagent_started" as const,
        subagentInvocationId: "future-subagent-call",
        subagentKind: "task",
        childConversationId: "subagent:future-child",
        historyMode: "isolated" as const,
      };

      await store.append(CONVERSATION_ID, [{ data, createdAtMs: 1_000 }]);

      expect((await store.loadHistory(CONVERSATION_ID))[0]?.data).toEqual(data);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back a failed startEpoch without leaving a partial epoch", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("epoch0") },
          createdAtMs: 1_000,
        },
      ]);

      // Force a failure inside the startEpoch transaction after its writes.
      const failing: JuniorSqlDatabase = {
        db: () => fixture.sql.db(),
        withLock: (name, callback) =>
          fixture.sql.withLock(name, async () => {
            await callback();
            throw new Error("epoch write failed");
          }),
        transaction: (callback) => fixture.sql.transaction(callback),
      };
      const failingStore = createSqlConversationEventStore(failing);

      await expect(
        failingStore.startEpoch(CONVERSATION_ID, {
          modelId: "test/model",
          reason: "rollback",
          modelProfile: "standard",
          messages: [{ message: userMessage("never"), createdAtMs: 2_000 }],
        }),
      ).rejects.toThrow("epoch write failed");

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.contextEpoch)).toEqual([0]);
      expect(
        history.some((event) => event.data.type === "context_epoch_started"),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { schemaVersion: 1, type: "bogus_type" },
    { schemaVersion: 2, type: "mcp_provider_connected" },
  ])(
    "fails loudly for unsupported stored event envelopes %#",
    async ({ schemaVersion, type }) => {
      const fixture = await createLocalJuniorSqlFixture();

      try {
        await migrateSchema(fixture.sql);
        await seedConversation(fixture, CONVERSATION_ID);
        const store = createSqlConversationEventStore(fixture.sql);

        await fixture.sql.execute(
          `
INSERT INTO junior_conversation_events (
  conversation_id, seq, context_epoch, schema_version, type, role, payload, created_at
) VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7)
`,
          [
            CONVERSATION_ID,
            0,
            0,
            schemaVersion,
            type,
            JSON.stringify(
              type === "mcp_provider_connected" ? { provider: "github" } : {},
            ),
            new Date(1_000).toISOString(),
          ],
        );

        await expect(store.loadHistory(CONVERSATION_ID)).rejects.toThrow(
          /Invalid input/,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it("uses physical event columns as authoritative when decoding rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await fixture.sql.execute(
        `
INSERT INTO junior_conversation_events (
  conversation_id, seq, context_epoch, schema_version, type, role, payload, created_at
) VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7)
`,
        [
          CONVERSATION_ID,
          0,
          0,
          1,
          "mcp_provider_connected",
          JSON.stringify({ type: "message", provider: "github" }),
          new Date(1_000).toISOString(),
        ],
      );

      await expect(store.loadHistory(CONVERSATION_ID)).resolves.toEqual([
        {
          schemaVersion: 1,
          seq: 0,
          contextEpoch: 0,
          createdAtMs: 1_000,
          data: { type: "mcp_provider_connected", provider: "github" },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("records messages idempotently and updates only replied_at", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationMessageStore(fixture.sql);

      await store.record(CONVERSATION_ID, [
        { messageId: "m1", role: "user", text: "first", createdAtMs: 1_000 },
        {
          messageId: "m2",
          role: "assistant",
          text: "reply",
          createdAtMs: 2_000,
        },
      ]);
      // Source redelivery must not duplicate or mutate the stored fact.
      await store.record(CONVERSATION_ID, [
        { messageId: "m1", role: "user", text: "changed", createdAtMs: 9_000 },
      ]);

      await store.markReplied(CONVERSATION_ID, "m1", 5_000);
      await store.markReplied(CONVERSATION_ID, "m1", 9_000);

      const listed = await listMessageRows(fixture, CONVERSATION_ID);
      expect(listed).toMatchObject([
        {
          conversationId: CONVERSATION_ID,
          messageId: "m1",
          role: "user",
          text: "first",
          createdAt: new Date(1_000),
          repliedAt: new Date(5_000),
        },
        {
          conversationId: CONVERSATION_ID,
          messageId: "m2",
          role: "assistant",
          text: "reply",
          createdAt: new Date(2_000),
          repliedAt: null,
        },
      ]);
      const visibleEvents = (
        await createSqlConversationEventStore(fixture.sql).loadHistory(
          CONVERSATION_ID,
        )
      ).filter((event) => event.data.type.startsWith("visible_message_"));
      expect(visibleEvents).toEqual([
        expect.objectContaining({
          idempotencyKey: "visible-message:m1:recorded",
          data: expect.objectContaining({
            type: "visible_message_recorded",
            messageId: "m1",
            text: "first",
          }),
        }),
        expect.objectContaining({
          idempotencyKey: "visible-message:m2:recorded",
          data: expect.objectContaining({
            type: "visible_message_recorded",
            messageId: "m2",
          }),
        }),
        expect.objectContaining({
          idempotencyKey: "visible-message:m1:replied",
          data: { type: "visible_message_replied", messageId: "m1" },
          createdAtMs: 5_000,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back a recorded event when its message projection fails", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      await fixture.sql.execute(`
        CREATE FUNCTION fail_visible_message_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'projection insert failed';
        END;
        $$
      `);
      await fixture.sql.execute(`
        CREATE TRIGGER fail_visible_message_insert_trigger
        BEFORE INSERT ON junior_conversation_messages
        FOR EACH ROW EXECUTE FUNCTION fail_visible_message_insert()
      `);
      const messages = createSqlConversationMessageStore(fixture.sql);

      await expect(
        messages.record(CONVERSATION_ID, [
          {
            messageId: "projection-failure",
            role: "user",
            text: "must roll back",
            createdAtMs: 1_000,
          },
        ]),
      ).rejects.toThrow(
        'Failed query: insert into "junior_conversation_messages"',
      );

      expect(await listMessageRows(fixture, CONVERSATION_ID)).toEqual([]);
      expect(
        await createSqlConversationEventStore(fixture.sql).loadHistory(
          CONVERSATION_ID,
        ),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back a replied event when its message projection fails", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const messages = createSqlConversationMessageStore(fixture.sql);
      await messages.record(CONVERSATION_ID, [
        {
          messageId: "reply-projection-failure",
          role: "user",
          text: "must stay unreplied",
          createdAtMs: 1_000,
        },
      ]);
      await fixture.sql.execute(`
        CREATE FUNCTION fail_visible_message_reply_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'projection reply update failed';
        END;
        $$
      `);
      await fixture.sql.execute(`
        CREATE TRIGGER fail_visible_message_reply_update_trigger
        BEFORE UPDATE OF replied_at ON junior_conversation_messages
        FOR EACH ROW EXECUTE FUNCTION fail_visible_message_reply_update()
      `);

      await expect(
        messages.markReplied(
          CONVERSATION_ID,
          "reply-projection-failure",
          2_000,
        ),
      ).rejects.toThrow('Failed query: update "junior_conversation_messages"');

      const projected = await listMessageRows(fixture, CONVERSATION_ID);
      expect(projected).toEqual([
        expect.objectContaining({ messageId: "reply-projection-failure" }),
      ]);
      expect(projected[0]?.repliedAt).toBe(null);
      const visibleEvents = (
        await createSqlConversationEventStore(fixture.sql).loadHistory(
          CONVERSATION_ID,
        )
      ).filter((event) => event.data.type.startsWith("visible_message_"));
      expect(visibleEvents.map((event) => event.data.type)).toEqual([
        "visible_message_recorded",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("advances last_activity_at on content writes without regressing on backdated content", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    async function lastActivityMs(): Promise<number> {
      const rows = await fixture.sql
        .db()
        .select({ lastActivityAt: juniorConversations.lastActivityAt })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      return rows[0]!.lastActivityAt.getTime();
    }

    try {
      await migrateSchema(fixture.sql);
      // Seed an old activity clock; content writes must refresh the window.
      await seedConversation(fixture, CONVERSATION_ID);
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ lastActivityAt: new Date(1_000) })
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      const messages = createSqlConversationMessageStore(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);

      // A newer message advances the clock (append-refresh semantics).
      await messages.record(CONVERSATION_ID, [
        { messageId: "m1", role: "user", text: "newer", createdAtMs: 5_000 },
      ]);
      expect(await lastActivityMs()).toBe(5_000);

      // A backdated message must not regress the clock.
      await messages.record(CONVERSATION_ID, [
        { messageId: "m0", role: "user", text: "older", createdAtMs: 2_000 },
      ]);
      expect(await lastActivityMs()).toBe(5_000);

      // A full working-set persist (oldest-first, as hydrate/persist cycles
      // write) advances the clock to the NEWEST message in the batch, not the
      // first.
      await messages.record(CONVERSATION_ID, [
        { messageId: "m0", role: "user", text: "older", createdAtMs: 2_000 },
        { messageId: "m1", role: "user", text: "newer", createdAtMs: 5_000 },
        {
          messageId: "m2",
          role: "assistant",
          text: "newest",
          createdAtMs: 6_500,
        },
      ]);
      expect(await lastActivityMs()).toBe(6_500);

      // Event appends advance the clock too, and also never regress it.
      await events.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("newest") },
          createdAtMs: 8_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
      await events.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("backdated") },
          createdAtMs: 3_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
    } finally {
      await fixture.close();
    }
  });

  it("purges events and messages for a conversation and its descendants", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      await seedConversation(fixture, CHILD_CONVERSATION_ID, CONVERSATION_ID);
      const events = createSqlConversationEventStore(fixture.sql);
      const messages = createSqlConversationMessageStore(fixture.sql);

      for (const conversationId of [CONVERSATION_ID, CHILD_CONVERSATION_ID]) {
        await events.append(conversationId, [
          {
            data: { type: "message", message: userMessage("hi") },
            createdAtMs: 1_000,
          },
        ]);
        await messages.record(conversationId, [
          { messageId: "m1", role: "user", text: "hi", createdAtMs: 1_000 },
        ]);
      }

      await purgeConversation(fixture.sql, CONVERSATION_ID, {
        nowMs: 5_000,
      });

      for (const conversationId of [CONVERSATION_ID, CHILD_CONVERSATION_ID]) {
        expect(await events.loadHistory(conversationId)).toEqual([]);
        expect(await listMessageRows(fixture, conversationId)).toEqual([]);
      }

      const rows = await fixture.sql
        .db()
        .select({
          conversationId: juniorConversations.conversationId,
          transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.transcriptPurgedAt).toBeInstanceOf(Date);

      await events.append(CONVERSATION_ID, [
        {
          data: { type: "message", message: userMessage("new history") },
          createdAtMs: 6_000,
        },
      ]);
      await messages.record(CONVERSATION_ID, [
        {
          messageId: "m2",
          role: "user",
          text: "new history",
          createdAtMs: 6_000,
        },
      ]);

      expect(await events.loadHistory(CONVERSATION_ID)).toHaveLength(2);
      expect(await listMessageRows(fixture, CONVERSATION_ID)).toHaveLength(1);
      const reopened = await fixture.sql
        .db()
        .select({
          transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(reopened[0]?.transcriptPurgedAt).toBe(null);
    } finally {
      await fixture.close();
    }
  });
});
