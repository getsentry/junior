import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import {
  conversationEventDataSchema,
  conversationEventSchema,
  newConversationEventSchema,
} from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import { purgeConversation } from "@/chat/conversations/retention";
import {
  persistConversationMessageSummaries,
  projectConversationMessageSummaries,
} from "@/chat/conversations/message-summaries";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
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
import { createConversationMemoryService } from "@/chat/services/conversation-memory";
import { projectConversationMessages } from "@/chat/conversations/message-projection";

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const CHILD_CONVERSATION_ID = "advisor:child-1";
const coreMigrationCount = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
}).length;

it("accepts compaction and handoff as the only live history replacements", () => {
  expect(
    conversationEventDataSchema.safeParse({
      type: "compaction",
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
      replacementHistory: [],
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "handoff",
      modelProfile: "handoff",
      modelId: "openai/gpt-5.6-sol",
      replacementHistory: [],
    }).success,
  ).toBe(true);
  expect(
    conversationEventDataSchema.safeParse({
      type: "handoff",
      modelProfile: "handoff",
      modelId: "openai/gpt-5.6-sol",
      triggeringToolCallId: "handoff-call-1",
      replacementHistory: [],
    }).success,
  ).toBe(true);
  for (const invalid of [
    { type: "context_epoch_started", reason: "initial" },
    { type: "compaction", modelProfile: "standard" },
    {
      type: "handoff",
      modelProfile: "handoff",
      replacementHistory: [],
    },
  ]) {
    expect(conversationEventDataSchema.safeParse(invalid).success).toBe(false);
  }
});

it("rejects unknown fields and legacy agent-step writes", () => {
  expect(
    conversationEventDataSchema.safeParse({
      type: "message",
      messageId: "m1",
      role: "user",
      text: "hello",
      unknown: true,
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "message_metadata_updated",
      messageId: "m1",
      meta: { imagesHydrated: true },
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "mcp_provider_connected",
      provider: "github",
      unknown: true,
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "tool_execution_started",
      toolCallId: "tool-call-1",
      toolName: "search",
      args: { token: "must-not-be-persisted" },
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "messages_summarized",
      historyFromSeq: 0,
      compactions: [
        {
          coveredMessageCount: 1,
          createdAtMs: 1_000,
          id: "compaction-1",
          summary: "Earlier context",
          unknown: true,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    newConversationEventSchema.safeParse({
      data: {
        type: "agent_step",
        message: { role: "", providerOwnedField: true },
      },
      createdAtMs: 1,
    }).success,
  ).toBe(false);
  expect(
    conversationEventDataSchema.safeParse({
      type: "user_message",
      content: [{ type: "provider_owned", value: true }],
      timestamp: 1,
      provenance: { authority: "context" },
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
      historyVersion: 0,
      createdAtMs: 1_000,
      data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
    }).success,
  ).toBe(false);
});

it("rejects history replacements through the ordinary append boundary", async () => {
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

it("rejects invalid turn route reasoning levels", async () => {
  await expect(
    getConversationEventStore().append("local:test:invalid-turn-route", [
      {
        data: {
          type: "turn_routed",
          turnId: "turn-1",
          modelProfile: "standard",
          modelId: "test-model",
          reasoningLevel: "maximum",
          source: "router",
        },
        createdAtMs: 1,
      } as never,
    ]),
  ).rejects.toThrow("Invalid option");
});

it("rejects incomplete handoffs through the replacement boundary", async () => {
  const conversationId = "local:test:invalid-marker-start";
  await expect(
    getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 1,
      data: {
        type: "handoff",
        modelProfile: "handoff",
        replacementHistory: [],
      },
    } as never),
  ).rejects.toThrow("Invalid input");
  await expect(
    getConversationEventStore().loadHistory(conversationId),
  ).resolves.toEqual([]);
});

it("keeps actor-owned MCP connections across history replacement", async () => {
  const conversationId = "local:test:host-fact-before-model";
  await recordMcpProviderConnected({
    conversationId,
    provider: "linear",
    credentialSubjectId: "UALICE",
  });
  await getConversationEventStore().replaceHistory(conversationId, {
    createdAtMs: 2,
    data: {
      type: "compaction",
      modelProfile: "standard",
      modelId: "test-model",
      replacementHistory: [],
    },
  });

  await expect(
    openConversationProjection({
      conversationId,
    }),
  ).resolves.toMatchObject({
    messages: [],
    modelProfile: "standard",
    modelId: "test-model",
  });
  await expect(
    loadConnectedMcpProviders({ conversationId, credentialSubjectId: "UALICE" }),
  ).resolves.toEqual(["linear"]);
  await expect(
    loadConnectedMcpProviders({ conversationId, credentialSubjectId: "UBOB" }),
  ).resolves.toEqual([]);
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
        ...(parentConversationId
          ? { parentConversationId, rootConversationId: parentConversationId }
          : {}),
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

function userMessageEvent(
  text: string,
  authority: "instruction" | "context" = "context",
  actor?: { platform: "slack" | "local" | "web" | "system"; name?: string },
) {
  const { content, timestamp } = userMessage(text);
  return {
    type: "user_message" as const,
    content,
    timestamp,
    provenance: {
      authority,
      ...(actor
        ? {
            actor:
              actor.platform === "system"
                ? { platform: "system" as const, name: actor.name ?? "system" }
                : actor.platform === "slack"
                  ? {
                      platform: "slack" as const,
                      teamId: "T123",
                      userId: "U123",
                    }
                  : {
                      platform: actor.platform,
                      userId: "user-1",
                    },
          }
        : {}),
    },
  };
}

describe("SQL conversation storage", () => {
  it("persists visible-context compaction snapshots in conversation history", async () => {
    const events = getConversationEventStore();
    const conversation = coerceThreadConversationState({});
    conversation.compactions = [
      {
        id: "compaction-1",
        summary: "Earlier visible context",
        coveredMessageCount: 2,
        createdAtMs: 2_000,
      },
    ];

    await persistConversationMessageSummaries({
      conversation,
      conversationId: CONVERSATION_ID,
    });
    await persistConversationMessageSummaries({
      conversation,
      conversationId: CONVERSATION_ID,
    });

    const history = await events.loadHistory(CONVERSATION_ID);
    expect(projectConversationMessageSummaries(history)).toEqual(
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
          data: userMessageEvent("one"),
          createdAtMs: 1_000,
        },
        {
          data: userMessageEvent("two"),
          createdAtMs: 2_000,
        },
      ]);
      await store.append(CONVERSATION_ID, [
        {
          data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
          createdAtMs: 3_000,
        },
      ]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.seq)).toEqual([0, 1, 2]);
      expect(history.map((event) => event.schemaVersion)).toEqual([1, 1, 1]);
      expect(history.map((event) => event.data.type)).toEqual([
        "user_message",
        "user_message",
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
            historyVersion: 0,
            schemaVersion: 1,
            type: "agent_step",
            payload: { message: userMessage("clobber") },
            createdAt: new Date(4_000),
          }),
      ).rejects.toThrow(Error);
    } finally {
      await fixture.close();
    }
  });

  it("loads the latest matching structured event directly", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      const structured = (
        namespace: string,
        name: string,
        fingerprint: string,
      ) => ({
        type: "structured_event" as const,
        namespace,
        name,
        version: 1,
        content: { fingerprint },
      });

      await store.append(CONVERSATION_ID, [
        {
          data: structured("junior", "agents_instructions_updated", "first"),
          createdAtMs: 1_000,
        },
        {
          data: structured("github", "pull_request_updated", "noise"),
          createdAtMs: 2_000,
        },
        {
          data: structured("junior", "agents_instructions_updated", "latest"),
          createdAtMs: 3_000,
        },
        {
          data: structured("junior", "authentication_linked", "newer-noise"),
          createdAtMs: 4_000,
        },
      ]);

      const event = await store.loadLatestStructuredEvent(
        CONVERSATION_ID,
        "junior",
        "agents_instructions_updated",
      );
      expect(event?.seq).toBe(2);
      expect(event?.data).toMatchObject({
        type: "structured_event",
        namespace: "junior",
        name: "agents_instructions_updated",
        content: { fingerprint: "latest" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("loads the latest user instruction", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("first instruction", "instruction"),
          createdAtMs: 1_000,
        },
        {
          data: userMessageEvent("ambient context"),
          createdAtMs: 2_000,
        },
        {
          data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
          createdAtMs: 3_000,
        },
        {
          data: userMessageEvent("latest instruction", "instruction"),
          createdAtMs: 4_000,
        },
      ]);

      const event = await store.loadLatestInstruction(CONVERSATION_ID);
      expect(event?.seq).toBe(3);
      expect(event?.data).toMatchObject({
        type: "user_message",
        content: userMessage("latest instruction").content,
        provenance: { authority: "instruction" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not refresh or unarchive a conversation for duplicate appends", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSqlConversationEventStore(fixture.sql);
      const firstEvent = {
        data: userMessageEvent("first", "instruction"),
        idempotencyKey: "event:first",
        createdAtMs: 1_000,
      };

      await store.append(CONVERSATION_ID, [firstEvent]);
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          archivedAt: new Date(2_000),
          transcriptPurgedAt: new Date(2_500),
        })
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

      const readConversationTimestamps = async () => {
        const [row] = await fixture.sql
          .db()
          .select({
            archivedAt: juniorConversations.archivedAt,
            lastActivityAt: juniorConversations.lastActivityAt,
            transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
            updatedAt: juniorConversations.updatedAt,
          })
          .from(juniorConversations)
          .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
        return row;
      };
      const archived = await readConversationTimestamps();

      await store.append(CONVERSATION_ID, [
        { ...firstEvent, createdAtMs: 9_000 },
      ]);

      expect(await readConversationTimestamps()).toEqual(archived);

      await store.append(CONVERSATION_ID, [
        { ...firstEvent, createdAtMs: 10_000 },
        {
          data: userMessageEvent("second", "instruction"),
          idempotencyKey: "event:second",
          createdAtMs: 8_000,
        },
      ]);

      expect(await readConversationTimestamps()).toEqual({
        archivedAt: null,
        lastActivityAt: new Date(8_000),
        transcriptPurgedAt: null,
        updatedAt: new Date(8_000),
      });
      expect(
        (await store.loadHistory(CONVERSATION_ID)).map((event) => ({
          idempotencyKey: event.idempotencyKey,
          seq: event.seq,
        })),
      ).toEqual([
        { idempotencyKey: "event:first", seq: 0 },
        { idempotencyKey: "event:second", seq: 1 },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps archive through system noise and restores only on human activity", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("seed", "instruction", { platform: "slack" }),
          idempotencyKey: "event:seed",
          createdAtMs: 1_000,
        },
      ]);
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          archivedAt: new Date(2_000),
          transcriptPurgedAt: new Date(2_500),
        })
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

      const readConversationTimestamps = async () => {
        const [row] = await fixture.sql
          .db()
          .select({
            archivedAt: juniorConversations.archivedAt,
            lastActivityAt: juniorConversations.lastActivityAt,
            transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
            updatedAt: juniorConversations.updatedAt,
          })
          .from(juniorConversations)
          .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
        return row;
      };
      const archived = await readConversationTimestamps();

      await store.append(CONVERSATION_ID, [
        {
          data: {
            type: "turn_started",
            turnId: "turn-1",
            inputMessageIds: ["msg-resource"],
            surface: "slack",
          },
          idempotencyKey: "event:turn-started",
          createdAtMs: 3_000,
        },
        {
          data: {
            type: "message",
            messageId: "msg-resource",
            role: "user",
            text: "Pull request checks failed.",
            meta: {
              eventType: "pull_request.checks.failed",
              author: {
                userId: "UJRNEVENT",
                userName: "junior-event",
                isBot: true,
              },
            },
          },
          idempotencyKey: "event:resource",
          createdAtMs: 3_100,
        },
        {
          data: userMessageEvent("ambient", "context"),
          idempotencyKey: "event:context",
          createdAtMs: 3_200,
        },
        {
          data: userMessageEvent("system", "instruction", {
            platform: "system",
            name: "resource-event",
          }),
          idempotencyKey: "event:system-instruction",
          createdAtMs: 3_300,
        },
        {
          data: {
            type: "message_updated",
            messageId: "msg-seed",
            role: "user",
            text: "seed (hydrated)",
            meta: {
              author: {
                userId: "U123",
                userName: "pierre",
                isBot: false,
              },
            },
          },
          idempotencyKey: "event:message-updated",
          createdAtMs: 3_400,
        },
      ]);

      expect(await readConversationTimestamps()).toEqual({
        ...archived,
        lastActivityAt: new Date(3_400),
        transcriptPurgedAt: null,
        updatedAt: new Date(3_400),
      });

      await store.replaceHistory(CONVERSATION_ID, {
        createdAtMs: 4_000,
        data: {
          type: "compaction",
          modelProfile: "coding",
          modelId: "openai/gpt-5.4",
          replacementHistory: [
            {
              item: userMessageEvent("summary", "instruction", {
                platform: "slack",
              }),
            },
          ],
        },
      });

      expect((await readConversationTimestamps())?.archivedAt).toEqual(
        archived?.archivedAt,
      );

      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("follow up", "instruction", {
            platform: "slack",
          }),
          idempotencyKey: "event:human",
          createdAtMs: 5_000,
        },
      ]);

      const restored = await readConversationTimestamps();
      expect(restored?.archivedAt).toBeNull();
      expect(restored?.transcriptPurgedAt).toBeNull();
      // replaceHistory refreshes activity with Date.now(); the human append
      // must still clear archive without regressing that clock.
      expect(restored?.lastActivityAt?.getTime()).toBeGreaterThanOrEqual(5_000);
    } finally {
      await fixture.close();
    }
  });

  it("deduplicates repeated keys within one append without leaving seq gaps", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlConversationEventStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          idempotencyKey: "event:repeated",
          createdAtMs: 1_000,
          data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
        },
        {
          idempotencyKey: "event:repeated",
          createdAtMs: 2_000,
          data: { type: "mcp_provider_connected", provider: "linear", credentialSubjectId: "U123" },
        },
        {
          idempotencyKey: "event:next",
          createdAtMs: 3_000,
          data: { type: "mcp_provider_connected", provider: "sentry", credentialSubjectId: "U123" },
        },
      ]);

      expect(
        (await store.loadHistory(CONVERSATION_ID)).map((event) => ({
          idempotencyKey: event.idempotencyKey,
          provider:
            event.data.type === "mcp_provider_connected"
              ? event.data.provider
              : undefined,
          seq: event.seq,
        })),
      ).toEqual([
        { idempotencyKey: "event:repeated", provider: "github", seq: 0 },
        { idempotencyKey: "event:next", provider: "sentry", seq: 1 },
      ]);
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
          data: userMessageEvent("before\u0000after and literal \\u0000"),
          createdAtMs: 1_000,
        },
      ]);

      expect((await store.loadHistory(CONVERSATION_ID))[0]?.data).toMatchObject(
        {
          type: "user_message",
          content: [{ text: "before after and literal \\u0000", type: "text" }],
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("returns only the active history version", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("epoch0-a"),
          createdAtMs: 1_000,
        },
        {
          data: userMessageEvent("epoch0-b"),
          createdAtMs: 2_000,
        },
      ]);
      await store.replaceHistory(CONVERSATION_ID, {
        createdAtMs: 3_000,
        data: {
          type: "compaction",
          modelProfile: "standard",
          modelId: "test/model",
          replacementHistory: [{ item: userMessageEvent("epoch1-summary") }],
        },
      });

      const current = await store.loadCurrentHistory(CONVERSATION_ID);
      expect(current.map((event) => event.historyVersion)).toEqual([1]);
      expect(current.map((event) => event.data.type)).toEqual(["compaction"]);
      expect(current.map((event) => event.seq)).toEqual([2]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.historyVersion)).toEqual([0, 0, 1]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("loads exactly the history version containing an event cursor", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("epoch0-a"),
          createdAtMs: 1_000,
        },
        {
          data: userMessageEvent("epoch0-b"),
          createdAtMs: 2_000,
        },
      ]);
      await store.replaceHistory(CONVERSATION_ID, {
        createdAtMs: 3_000,
        data: {
          type: "compaction",
          modelProfile: "standard",
          modelId: "test/model",
          replacementHistory: [{ item: userMessageEvent("epoch1-summary") }],
        },
      });
      await store.append(CONVERSATION_ID, [
        {
          data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
          createdAtMs: 4_000,
        },
      ]);
      await store.replaceHistory(CONVERSATION_ID, {
        createdAtMs: 5_000,
        data: {
          type: "compaction",
          modelId: "test/model",
          modelProfile: "standard",
          replacementHistory: [{ item: userMessageEvent("epoch2-message") }],
        },
      });

      expect(
        (await store.loadHistoryContaining(CONVERSATION_ID, 0))?.map(
          (event) => [event.seq, event.historyVersion],
        ),
      ).toEqual([
        [0, 0],
        [1, 0],
      ]);
      expect(
        (await store.loadHistoryContaining(CONVERSATION_ID, 2))?.map(
          (event) => event.seq,
        ),
      ).toEqual([2, 3]);
      expect(
        (await store.loadHistoryContaining(CONVERSATION_ID, 4))?.map(
          (event) => event.seq,
        ),
      ).toEqual([4]);
      await expect(
        store.loadHistoryContaining(CONVERSATION_ID, 99),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("does not decode events after a fixed epoch boundary", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("committed"),
          createdAtMs: 1_000,
        },
        {
          data: { type: "mcp_provider_connected", provider: "github", credentialSubjectId: "U123" },
          createdAtMs: 2_000,
        },
      ]);
      await fixture.sql.execute(
        `
INSERT INTO junior_conversation_events (
  conversation_id, seq, history_version, schema_version, type, payload, created_at
) VALUES ($1, 2, 0, 1, 'message', '{}'::jsonb, $2)
`,
        [CONVERSATION_ID, new Date(3_000).toISOString()],
      );

      await expect(
        store.loadHistoryContaining(CONVERSATION_ID, 1, 1),
      ).resolves.toEqual([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ seq: 1 }),
      ]);
      await expect(
        store.loadHistoryContaining(CONVERSATION_ID, 1),
      ).rejects.toThrow(/Invalid input/);
    } finally {
      await fixture.close();
    }
  });

  it("narrow reads do not decode unrelated or superseded events", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await fixture.sql.execute(
        `
INSERT INTO junior_conversation_events (
  conversation_id, seq, history_version, schema_version, type, payload, created_at
) VALUES
  ($1, 0, 0, 1, 'message', '{}'::jsonb, $2),
  ($1, 1, 0, 1, 'messages_summarized', '{}'::jsonb, $2),
  ($1, 2, 0, 1, 'message', $3::jsonb, $2),
  ($1, 3, 0, 1, 'messages_summarized', $4::jsonb, $2)
`,
        [
          CONVERSATION_ID,
          new Date(1_000).toISOString(),
          JSON.stringify({ messageId: "m1", role: "user", text: "hello" }),
          JSON.stringify({ historyFromSeq: 2, compactions: [] }),
        ],
      );

      await expect(store.loadMessageHistory(CONVERSATION_ID)).resolves.toEqual({
        events: [
          expect.objectContaining({
            seq: 2,
            data: expect.objectContaining({
              type: "message",
              messageId: "m1",
            }),
          }),
        ],
        compaction: expect.objectContaining({
          seq: 3,
          data: {
            type: "messages_summarized",
            historyFromSeq: 2,
            compactions: [],
          },
        }),
        historyFromSeq: 2,
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps a bounded visible suffix after compacting more than 864 messages", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      const conversation = coerceThreadConversationState({});
      conversation.messages = Array.from({ length: 2_000 }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        text: "x".repeat(3_200),
        createdAtMs: index + 1,
      }));
      await store.append(
        CONVERSATION_ID,
        conversation.messages.map((message) => ({
          data: {
            type: "message" as const,
            messageId: message.id,
            role: message.role,
            text: message.text,
          },
          createdAtMs: message.createdAtMs,
        })),
      );

      const memory = createConversationMemoryService({
        completeText: async () => ({ text: "summary" }) as never,
      });
      await memory.compactConversationIfNeeded(conversation, {});
      const coveredMessageCount = conversation.compactions.reduce(
        (count, compaction) => count + compaction.coveredMessageCount,
        0,
      );
      expect(coveredMessageCount).toBe(2_000 - conversation.messages.length);
      expect(coveredMessageCount).toBeGreaterThan(864);
      expect(conversation.compactions.length).toBeLessThanOrEqual(16);

      const historyFromSeq = Number(
        conversation.messages[0]?.id.replace("message-", ""),
      );
      await store.append(CONVERSATION_ID, [
        {
          data: {
            type: "messages_summarized",
            historyFromSeq,
            compactions: conversation.compactions,
          },
          createdAtMs: 3_000,
        },
      ]);
      await fixture.sql.execute(
        `
UPDATE junior_conversation_events
SET payload = '{}'::jsonb
WHERE conversation_id = $1 AND seq = 0
`,
        [CONVERSATION_ID],
      );

      const visible = await store.loadMessageHistory(CONVERSATION_ID);
      expect(visible.events[0]?.seq).toBe(historyFromSeq);
      expect(visible.events).toHaveLength(conversation.messages.length);
      expect(
        projectConversationMessages(visible).map((message) => message.id),
      ).toEqual(conversation.messages.map((message) => message.id));
    } finally {
      await fixture.close();
    }
  }, 30_000);

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
      };

      await store.append(CONVERSATION_ID, [{ data, createdAtMs: 1_000 }]);

      expect((await store.loadHistory(CONVERSATION_ID))[0]?.data).toEqual(data);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back a failed history replacement transaction", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("epoch0"),
          createdAtMs: 1_000,
        },
      ]);

      // Force a failure inside the replacement transaction after its writes.
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
        failingStore.replaceHistory(CONVERSATION_ID, {
          createdAtMs: 2_000,
          data: {
            type: "compaction",
            modelId: "test/model",
            modelProfile: "standard",
            replacementHistory: [{ item: userMessageEvent("never") }],
          },
        }),
      ).rejects.toThrow("epoch write failed");

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => event.historyVersion)).toEqual([0]);
      expect(history.some((event) => event.data.type === "compaction")).toBe(
        false,
      );
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { schemaVersion: 1, type: "bogus_type", payload: {} },
    {
      schemaVersion: 2,
      type: "mcp_provider_connected",
      payload: { provider: "github" },
    },
  ])(
    "preserves unsupported stored events as opaque facts %#",
    async ({ schemaVersion, type, payload }) => {
      const fixture = await createLocalJuniorSqlFixture();

      try {
        await migrateSchema(fixture.sql);
        await seedConversation(fixture, CONVERSATION_ID);
        const store = createSqlConversationEventStore(fixture.sql);

        await fixture.sql.execute(
          `
INSERT INTO junior_conversation_events (
  conversation_id, seq, history_version, schema_version, type, payload, created_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
`,
          [
            CONVERSATION_ID,
            0,
            0,
            schemaVersion,
            type,
            JSON.stringify(payload),
            new Date(1_000).toISOString(),
          ],
        );

        await expect(store.loadHistory(CONVERSATION_ID)).resolves.toEqual([
          {
            schemaVersion,
            seq: 0,
            historyVersion: 0,
            createdAtMs: 1_000,
            data: {
              type: "unknown",
              originalType: type,
              payload,
            },
          },
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("rejects malformed payloads for supported stored events", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await fixture.sql.execute(
        `
INSERT INTO junior_conversation_events (
  conversation_id, seq, history_version, schema_version, type, payload, created_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
`,
        [
          CONVERSATION_ID,
          0,
          0,
          1,
          "mcp_provider_connected",
          JSON.stringify({}),
          new Date(1_000).toISOString(),
        ],
      );

      await expect(store.loadHistory(CONVERSATION_ID)).rejects.toThrow(
        /Invalid input/,
      );
    } finally {
      await fixture.close();
    }
  });

  it("uses physical event columns as authoritative when decoding rows", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);

      await fixture.sql.execute(
        `
INSERT INTO junior_conversation_events (
  conversation_id, seq, history_version, schema_version, type, payload, created_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
`,
        [
          CONVERSATION_ID,
          0,
          0,
          1,
          "mcp_provider_connected",
          JSON.stringify({
            type: "message",
            provider: "github",
            credentialSubjectId: "U123",
          }),
          new Date(1_000).toISOString(),
        ],
      );

      await expect(store.loadHistory(CONVERSATION_ID)).resolves.toEqual([
        {
          schemaVersion: 1,
          seq: 0,
          historyVersion: 0,
          createdAtMs: 1_000,
          data: {
            type: "mcp_provider_connected",
            provider: "github",
            credentialSubjectId: "U123",
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("records message and handled facts idempotently", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          idempotencyKey: "message:m1",
          data: {
            type: "message",
            messageId: "m1",
            role: "user",
            text: "first",
          },
          createdAtMs: 1_000,
        },
        {
          idempotencyKey: "message:m2",
          data: {
            type: "message",
            messageId: "m2",
            role: "assistant",
            text: "reply",
          },
          createdAtMs: 2_000,
        },
      ]);
      await store.append(CONVERSATION_ID, [
        {
          idempotencyKey: "message:m1",
          data: {
            type: "message",
            messageId: "m1",
            role: "user",
            text: "changed",
          },
          createdAtMs: 9_000,
        },
        {
          idempotencyKey: "message:m1:handled",
          data: { type: "message_handled", messageId: "m1" },
          createdAtMs: 5_000,
        },
        {
          idempotencyKey: "message:m1:handled",
          data: { type: "message_handled", messageId: "m1" },
          createdAtMs: 9_000,
        },
      ]);
      const history = await store.loadMessageHistory(CONVERSATION_ID);
      expect(projectConversationMessages(history)).toEqual([
        {
          id: "m1",
          role: "user",
          text: "first",
          createdAtMs: 1_000,
          meta: { replied: true },
        },
        {
          id: "m2",
          role: "assistant",
          text: "reply",
          createdAtMs: 2_000,
        },
      ]);
      expect(await store.loadHistory(CONVERSATION_ID)).toHaveLength(3);
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
      const events = createSqlConversationEventStore(fixture.sql);

      await events.append(CONVERSATION_ID, [
        {
          data: {
            type: "message",
            messageId: "m1",
            role: "user",
            text: "newer",
          },
          createdAtMs: 5_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(5_000);

      await events.append(CONVERSATION_ID, [
        {
          data: {
            type: "message",
            messageId: "m0",
            role: "user",
            text: "older",
          },
          createdAtMs: 2_000,
        },
        {
          data: {
            type: "message",
            messageId: "m2",
            role: "assistant",
            text: "newest",
          },
          createdAtMs: 6_500,
        },
      ]);
      expect(await lastActivityMs()).toBe(6_500);

      // Event appends advance the clock too, and also never regress it.
      await events.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("newest"),
          createdAtMs: 8_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
      await events.append(CONVERSATION_ID, [
        {
          data: userMessageEvent("backdated"),
          createdAtMs: 3_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
    } finally {
      await fixture.close();
    }
  });

  it("purges conversation events for a conversation and its descendants", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      await seedConversation(fixture, CHILD_CONVERSATION_ID, CONVERSATION_ID);
      const events = createSqlConversationEventStore(fixture.sql);

      for (const conversationId of [CONVERSATION_ID, CHILD_CONVERSATION_ID]) {
        await events.append(conversationId, [
          {
            data: userMessageEvent("hi"),
            createdAtMs: 1_000,
          },
          {
            data: {
              type: "message",
              messageId: "m1",
              role: "user",
              text: "hi",
            },
            createdAtMs: 1_000,
          },
        ]);
      }

      await purgeConversation(fixture.sql, CONVERSATION_ID, {
        nowMs: 5_000,
      });

      for (const conversationId of [CONVERSATION_ID, CHILD_CONVERSATION_ID]) {
        expect(await events.loadHistory(conversationId)).toEqual([]);
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
          data: userMessageEvent("new history"),
          createdAtMs: 6_000,
        },
        {
          data: {
            type: "message",
            messageId: "m2",
            role: "user",
            text: "new history",
          },
          createdAtMs: 6_000,
        },
      ]);

      expect(await events.loadHistory(CONVERSATION_ID)).toHaveLength(2);
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
