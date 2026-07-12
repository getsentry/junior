import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import { agentStepEntrySchema } from "@/chat/conversations/history";
import { getAgentStepStore } from "@/chat/db";
import { purgeConversation } from "@/chat/conversations/retention";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import {
  hydrateConversationCompactions,
  persistConversationCompactions,
} from "@/chat/conversations/visible-compactions";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAgentSteps, juniorConversations } from "@/db/schema";
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

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const CHILD_CONVERSATION_ID = "advisor:child-1";

it("accepts legacy markers and validates current profile names", () => {
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "initial",
      modelProfile: "standard",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "initial",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(true);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "handoff",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "Fast!",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
    }).success,
  ).toBe(true);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(true);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelProfile: "coding",
    }).success,
  ).toBe(false);
  expect(
    agentStepEntrySchema.safeParse({
      type: "context_epoch_started",
      reason: "compaction",
      modelId: "openai/gpt-5.4",
    }).success,
  ).toBe(false);
});

it("rejects epoch markers through the ordinary append boundary", async () => {
  await expect(
    getAgentStepStore().append("local:test:invalid-marker-append", [
      {
        entry: {
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
    getAgentStepStore().startEpoch(conversationId, {
      reason: "handoff",
      modelProfile: "handoff",
      messages: [],
    } as never),
  ).rejects.toThrow("Invalid input");
  await expect(
    getAgentStepStore().loadHistory(conversationId),
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
  expect(await getAgentStepStore().loadHistory(conversationId)).toEqual([
    expect.objectContaining({
      contextEpoch: 0,
      entry: expect.objectContaining({ type: "mcp_provider_connected" }),
    }),
    expect.objectContaining({
      contextEpoch: 0,
      entry: {
        type: "context_epoch_started",
        reason: "initial",
        modelProfile: "standard",
        modelId: "openai/gpt-5.4",
      },
    }),
  ]);
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
  it("persists visible-context compaction snapshots in agent history", async () => {
    const steps = getAgentStepStore();
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

    const rehydrated = coerceThreadConversationState({});
    await hydrateConversationCompactions({
      conversation: rehydrated,
      conversationId: CONVERSATION_ID,
    });
    expect(rehydrated.compactions).toEqual(conversation.compactions);
    expect(await steps.loadHistory(CONVERSATION_ID)).toHaveLength(1);
  });

  it("applies Drizzle migrations idempotently", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await migrateSchema(fixture.sql);

      const [applied] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );
      expect(applied?.count).toBe(3);
    } finally {
      await fixture.close();
    }
  });

  it("assigns sequential seq and fences conflicting appends loudly", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlAgentStepStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("one") },
          createdAtMs: 1_000,
        },
        {
          entry: { type: "pi_message", message: userMessage("two") },
          createdAtMs: 2_000,
        },
      ]);
      await store.append(CONVERSATION_ID, [
        {
          entry: { type: "mcp_provider_connected", provider: "github" },
          createdAtMs: 3_000,
        },
      ]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((step) => step.seq)).toEqual([0, 1, 2]);
      expect(history.map((step) => step.entry.type)).toEqual([
        "pi_message",
        "pi_message",
        "mcp_provider_connected",
      ]);

      // A writer that lost its lease and reuses seq 0 must fail on the PK.
      await expect(
        fixture.sql
          .db()
          .insert(juniorAgentSteps)
          .values({
            conversationId: CONVERSATION_ID,
            seq: 0,
            contextEpoch: 0,
            type: "pi_message",
            role: "user",
            payload: { message: userMessage("clobber") },
            createdAt: new Date(4_000),
          }),
      ).rejects.toThrow(Error);
    } finally {
      await fixture.close();
    }
  });

  it("returns only the highest epoch from loadCurrentEpoch", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlAgentStepStore(fixture.sql);

      await store.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("epoch0-a") },
          createdAtMs: 1_000,
        },
        {
          entry: { type: "pi_message", message: userMessage("epoch0-b") },
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
      expect(current.map((step) => step.contextEpoch)).toEqual([1, 1]);
      expect(current.map((step) => step.entry.type)).toEqual([
        "context_epoch_started",
        "pi_message",
      ]);
      expect(current.map((step) => step.seq)).toEqual([2, 3]);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((step) => step.contextEpoch)).toEqual([0, 0, 1, 1]);
    } finally {
      await fixture.close();
    }
  });

  it("round trips provider-neutral isolated subagent history", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlAgentStepStore(fixture.sql);
      const entry = {
        type: "subagent_started" as const,
        subagentInvocationId: "future-subagent-call",
        subagentKind: "task",
        childConversationId: "subagent:future-child",
        historyMode: "isolated" as const,
      };

      await store.append(CONVERSATION_ID, [{ entry, createdAtMs: 1_000 }]);

      expect((await store.loadHistory(CONVERSATION_ID))[0]?.entry).toEqual(
        entry,
      );
    } finally {
      await fixture.close();
    }
  });

  it("rolls back a failed startEpoch without leaving a partial epoch", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlAgentStepStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("epoch0") },
          createdAtMs: 1_000,
        },
      ]);

      // Force a failure inside the startEpoch transaction after its writes.
      const failing: JuniorSqlDatabase = {
        db: () => fixture.sql.db(),
        withLock: (name, callback) => fixture.sql.withLock(name, callback),
        transaction: (callback) =>
          fixture.sql.transaction(async () => {
            await callback();
            throw new Error("epoch write failed");
          }),
      };
      const failingStore = createSqlAgentStepStore(failing);

      await expect(
        failingStore.startEpoch(CONVERSATION_ID, {
          modelId: "test/model",
          reason: "rollback",
          modelProfile: "standard",
          messages: [{ message: userMessage("never"), createdAtMs: 2_000 }],
        }),
      ).rejects.toThrow("epoch write failed");

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((step) => step.contextEpoch)).toEqual([0]);
      expect(
        history.some((step) => step.entry.type === "context_epoch_started"),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("fails loudly when a stored step has an unknown type", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      const store = createSqlAgentStepStore(fixture.sql);

      await fixture.sql.execute(
        `
INSERT INTO junior_agent_steps (
  conversation_id, seq, context_epoch, type, role, payload, created_at
) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6)
`,
        [
          CONVERSATION_ID,
          0,
          0,
          "bogus_type",
          "{}",
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

      const listed = await store.list(CONVERSATION_ID);
      expect(listed).toEqual([
        {
          conversationId: CONVERSATION_ID,
          messageId: "m1",
          role: "user",
          text: "first",
          createdAtMs: 1_000,
          repliedAtMs: 5_000,
        },
        {
          conversationId: CONVERSATION_ID,
          messageId: "m2",
          role: "assistant",
          text: "reply",
          createdAtMs: 2_000,
        },
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
      const steps = createSqlAgentStepStore(fixture.sql);

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

      // Step appends advance the clock too, and also never regress it.
      await steps.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("newest") },
          createdAtMs: 8_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
      await steps.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("backdated") },
          createdAtMs: 3_000,
        },
      ]);
      expect(await lastActivityMs()).toBe(8_000);
    } finally {
      await fixture.close();
    }
  });

  it("purges steps and messages for a conversation and its descendants", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await seedConversation(fixture, CONVERSATION_ID);
      await seedConversation(fixture, CHILD_CONVERSATION_ID, CONVERSATION_ID);
      const steps = createSqlAgentStepStore(fixture.sql);
      const messages = createSqlConversationMessageStore(fixture.sql);

      for (const conversationId of [CONVERSATION_ID, CHILD_CONVERSATION_ID]) {
        await steps.append(conversationId, [
          {
            entry: { type: "pi_message", message: userMessage("hi") },
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
        expect(await steps.loadHistory(conversationId)).toEqual([]);
        expect(await messages.list(conversationId)).toEqual([]);
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

      await steps.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: userMessage("new history") },
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

      expect(await steps.loadHistory(CONVERSATION_ID)).toHaveLength(1);
      expect(await messages.list(CONVERSATION_ID)).toHaveLength(1);
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
