import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  createPendingConversationDelivery,
  claimPendingConversationDelivery,
  loadPendingDeliveryByTurn,
  markPendingDeliveryPosting,
  recordPendingDeliveryAccepted,
  recordPendingDeliveryFailed,
  terminalizeAcceptedPendingDelivery,
  terminalizeFailedPendingDelivery,
  PendingDeliveryLeaseLostError,
} from "@/chat/conversations/sql/delivery-outbox";
import {
  conversationDeliveryFailureCodeSchema,
  pendingConversationDeliveryCommandSchema,
  type PendingConversationDeliveryCommand,
} from "@/chat/conversations/delivery";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { purgeConversation } from "@/chat/conversations/retention";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorPendingDeliveries,
} from "@/db/schema";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const CONVERSATION_ID = "slack:C123:1718123456.000000";
const DELIVERY_ID = "delivery:turn-1";

function command(
  overrides: Partial<PendingConversationDeliveryCommand> = {},
): PendingConversationDeliveryCommand {
  return pendingConversationDeliveryCommandSchema.parse({
    publicLocator: "0123456789Abcdefgh_-XY",
    session: {
      surface: "slack",
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
        type: "pub",
        messageTs: "1718123456.000000",
        threadTs: "1718123456.000000",
      },
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      destinationVisibility: "public",
      actor: { platform: "slack", teamId: "T123", userId: "U123" },
      channelName: "eng-runtime",
      startedAtMs: 900,
    },
    route: { channelId: "C123", threadTs: "1718123456.000000" },
    parts: [{ text: "First" }, { text: "Second" }],
    completion: {
      turnId: "turn-1",
      inputMessageIds: ["user-1"],
      assistantMessage: {
        messageId: "assistant:turn-1",
        text: "First\nSecond",
        createdAtMs: 950,
        author: { userName: "junior", isBot: true },
      },
      model: {
        modelId: "openai/gpt-5.4",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "First\nSecond" }],
          },
        ],
      },
      sliceId: 1,
      terminal: { outcome: "success" },
    },
    ...overrides,
  });
}

async function createDelivery(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
  overrides: {
    conversationId?: string;
    deliveryId?: string;
    turnId?: string;
    command?: PendingConversationDeliveryCommand;
  } = {},
) {
  return createPendingConversationDelivery(fixture.sql, {
    conversationId: overrides.conversationId ?? CONVERSATION_ID,
    deliveryId: overrides.deliveryId ?? DELIVERY_ID,
    turnId: overrides.turnId ?? "turn-1",
    command: overrides.command ?? command(),
    nowMs: 1_000,
  });
}

describe("pending conversation delivery outbox", () => {
  it("validates a narrow immutable command and creates control state idempotently", async () => {
    expect(
      conversationDeliveryFailureCodeSchema.safeParse("retry_exhausted")
        .success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        authorizationUrl: "https://secret.example/oauth",
      }).success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        session: { ...command().session, loadedSkillNames: ["triage"] },
      }).success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        session: { ...command().session, turnStartMessageIndex: 1 },
      }).success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        route: { channelId: "C999", threadTs: "1718123456.000000" },
      }).success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        completion: {
          ...command().completion,
          assistantMessage: {
            ...command().completion.assistantMessage,
            messageId: "assistant:wrong-turn",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        providerResponse: { ok: true },
      }).success,
    ).toBe(false);

    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const first = await createDelivery(fixture);
      const second = await createDelivery(fixture);

      expect(second).toEqual(first);
      expect(
        await loadPendingDeliveryByTurn(fixture.sql, {
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
        }),
      ).toEqual(first);
      await expect(
        createSqlConversationEventStore(fixture.sql).loadHistory(
          CONVERSATION_ID,
        ),
      ).resolves.toEqual([]);

      await expect(
        createPendingConversationDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: "delivery:different",
          turnId: "turn-1",
          command: command(),
          nowMs: 2_000,
        }),
      ).rejects.toThrow("different pending delivery");
      const nextTurnCommand = command({
        completion: {
          ...command().completion,
          turnId: "turn-2",
          assistantMessage: {
            ...command().completion.assistantMessage,
            messageId: "assistant:turn-2",
          },
        },
      });
      await expect(
        createDelivery(fixture, {
          deliveryId: "delivery:turn-2",
          turnId: "turn-2",
          command: nextTurnCommand,
        }),
      ).rejects.toThrow(
        "Conversation already has a different pending delivery",
      );
    } finally {
      await fixture.close();
    }
  });

  it("fails closed on turn-terminal idempotency-key collisions", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      await events.append(CONVERSATION_ID, [
        {
          idempotencyKey: "turn:turn-1:terminal",
          createdAtMs: 900,
          data: { type: "mcp_provider_connected", provider: "github" },
        },
      ]);
      await expect(createDelivery(fixture)).rejects.toThrow(
        "unexpected event type",
      );
    } finally {
      await fixture.close();
    }
  });

  it("fences concurrent claims and recovers stale posting as uncertain", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await createDelivery(fixture);
      const claims = await Promise.all([
        claimPendingConversationDelivery(fixture.sql, {
          deliveryId: DELIVERY_ID,
          leaseOwner: "worker-a",
          nowMs: 1_001,
          leaseDurationMs: 100,
        }),
        claimPendingConversationDelivery(fixture.sql, {
          deliveryId: DELIVERY_ID,
          leaseOwner: "worker-b",
          nowMs: 1_001,
          leaseDurationMs: 100,
        }),
      ]);
      const claimed = claims.find((claim) => claim !== undefined)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      await markPendingDeliveryPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        lease: claimed.lease!,
        nowMs: 1_002,
      });

      const recovered = await claimPendingConversationDelivery(fixture.sql, {
        deliveryId: DELIVERY_ID,
        leaseOwner: "worker-c",
        nowMs: 1_102,
        leaseDurationMs: 100,
      });
      expect(recovered?.progress.currentState).toEqual({
        status: "uncertain",
        attemptedAtMs: 1_002,
      });
      await expect(
        recordPendingDeliveryAccepted(fixture.sql, {
          deliveryId: DELIVERY_ID,
          lease: claimed.lease!,
          providerMessageId: "1718123457.000001",
          nowMs: 1_103,
        }),
      ).rejects.toBeInstanceOf(PendingDeliveryLeaseLostError);
    } finally {
      await fixture.close();
    }
  });

  it("persists ordered multipart receipts and a definitive failure", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await createDelivery(fixture);
      const claimed = await claimPendingConversationDelivery(fixture.sql, {
        deliveryId: DELIVERY_ID,
        leaseOwner: "worker-a",
        nowMs: 1_001,
        leaseDurationMs: 1_000,
      });
      const lease = claimed!.lease!;
      await markPendingDeliveryPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        lease,
        nowMs: 1_002,
      });
      const firstAccepted = await recordPendingDeliveryAccepted(fixture.sql, {
        deliveryId: DELIVERY_ID,
        lease,
        providerMessageId: "1718123457.000001",
        nowMs: 1_003,
      });
      expect(firstAccepted.nextPartIndex).toBe(1);
      expect(firstAccepted.progress.acceptedReceipts).toEqual([
        "1718123457.000001",
      ]);
      await markPendingDeliveryPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        lease,
        nowMs: 1_004,
      });
      const failed = await recordPendingDeliveryFailed(fixture.sql, {
        deliveryId: DELIVERY_ID,
        lease,
        failureCode: "provider_rejected",
        nowMs: 1_005,
      });
      expect(failed.progress.currentState).toEqual({
        status: "failed",
        failureCode: "provider_rejected",
      });
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_006,
          finalizer: vi.fn(),
        }),
      ).rejects.toThrow("every part is accepted");

      const failureFinalizer = vi.fn(async () => {
        await new ConversationTurnLifecycleService(
          createSqlConversationEventStore(fixture.sql),
        ).fail({
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
          createdAtMs: 1_007,
          failureCode: "delivery_failed",
        });
      });
      await expect(
        terminalizeFailedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_007,
          finalizer: failureFinalizer,
        }),
      ).resolves.toBe("finalized");
      await expect(
        terminalizeFailedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_008,
          finalizer: failureFinalizer,
        }),
      ).resolves.toBe("already_finalized");
      expect(failureFinalizer).toHaveBeenCalledTimes(1);
      const history = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(CONVERSATION_ID);
      expect(
        history.filter(
          (event) =>
            event.data.type === "turn_failed" &&
            event.data.failureCode === "delivery_failed",
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back finalization and retries without duplicate canonical facts", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await createDelivery(fixture);
      const claimed = await claimPendingConversationDelivery(fixture.sql, {
        deliveryId: DELIVERY_ID,
        leaseOwner: "worker-a",
        nowMs: 1_001,
        leaseDurationMs: 5_000,
      });
      const lease = claimed!.lease!;
      for (const index of [0, 1]) {
        await markPendingDeliveryPosting(fixture.sql, {
          deliveryId: DELIVERY_ID,
          lease,
          nowMs: 1_010 + index * 2,
        });
        await recordPendingDeliveryAccepted(fixture.sql, {
          deliveryId: DELIVERY_ID,
          lease,
          providerMessageId: `1718123457.00000${index + 1}`,
          nowMs: 1_011 + index * 2,
        });
      }

      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_020,
          finalizer: async () => {
            await fixture.sql
              .db()
              .update(juniorConversations)
              .set({ title: "must roll back" })
              .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
            throw new Error("finalizer failed");
          },
        }),
      ).rejects.toThrow("finalizer failed");
      expect(
        await loadPendingDeliveryByTurn(fixture.sql, {
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
        }),
      ).toBeDefined();
      const [conversationAfterRollback] = await fixture.sql
        .db()
        .select({ title: juniorConversations.title })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(conversationAfterRollback?.title).toBeNull();

      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_020,
          finalizer: async () => {
            await fixture.sql
              .db()
              .update(juniorConversations)
              .set({ title: "wrong terminal" })
              .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
            await new ConversationTurnLifecycleService(
              createSqlConversationEventStore(fixture.sql),
            ).complete({
              conversationId: CONVERSATION_ID,
              turnId: "turn-1",
              createdAtMs: 1_020,
              outcome: "no_reply",
            });
          },
        }),
      ).rejects.toThrow("did not write the expected turn terminal");
      expect(
        await loadPendingDeliveryByTurn(fixture.sql, {
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
        }),
      ).toBeDefined();

      const finalizer = vi.fn(async () => {
        await fixture.sql
          .db()
          .update(juniorConversations)
          .set({ title: "finalized" })
          .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
        await new ConversationTurnLifecycleService(
          createSqlConversationEventStore(fixture.sql),
        ).complete({
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
          createdAtMs: 1_021,
          outcome: "success",
        });
      });
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_021,
          finalizer,
        }),
      ).resolves.toBe("finalized");
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          turnId: "turn-1",
          lease,
          nowMs: 1_022,
          finalizer,
        }),
      ).resolves.toBe("already_finalized");
      expect(finalizer).toHaveBeenCalledTimes(1);
      await expect(createDelivery(fixture)).rejects.toThrow(
        "already terminalized",
      );
      const events = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(CONVERSATION_ID);
      expect(
        events.filter((event) => event.data.type === "turn_completed"),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("cascades unresolved control state when its conversation row is deleted", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await createDelivery(fixture);
      await fixture.sql
        .db()
        .delete(juniorConversationEvents)
        .where(eq(juniorConversationEvents.conversationId, CONVERSATION_ID));
      await fixture.sql
        .db()
        .delete(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      const rows = await fixture.sql
        .db()
        .select({ id: juniorPendingDeliveries.deliveryId })
        .from(juniorPendingDeliveries)
        .orderBy(asc(juniorPendingDeliveries.deliveryId));
      expect(rows).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("deletes raw pending commands when conversation content is retained only as metadata", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await createDelivery(fixture);
      await purgeConversation(fixture.sql, CONVERSATION_ID, { nowMs: 5_000 });

      expect(
        await loadPendingDeliveryByTurn(fixture.sql, {
          conversationId: CONVERSATION_ID,
          turnId: "turn-1",
        }),
      ).toBeUndefined();
      const [conversation] = await fixture.sql
        .db()
        .select({ transcriptPurgedAt: juniorConversations.transcriptPurgedAt })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      expect(conversation?.transcriptPurgedAt).toBeInstanceOf(Date);
    } finally {
      await fixture.close();
    }
  });
});
