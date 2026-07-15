import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  createPendingConversationDelivery,
  claimPendingConversationDelivery,
  loadPendingDeliveryByTurn,
  markPendingDeliveryPartPosting,
  markPendingDeliveryPartRepostable,
  recordPendingDeliveryPartAccepted,
  recordPendingDeliveryPartFailed,
  recordPendingDeliveryPartUncertain,
  terminalizeAcceptedPendingDelivery,
  terminalizeFailedPendingDelivery,
  PendingDeliveryLeaseLostError,
} from "@/chat/conversations/sql/delivery-outbox";
import {
  deliveryIntentEventKey,
  deliveryTerminalEventKey,
  pendingConversationDeliveryCommandSchema,
  type PendingConversationDeliveryCommand,
} from "@/chat/conversations/delivery";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
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
    version: 1,
    provider: "slack",
    deliveryKind: "assistant_reply",
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
    parts: [
      { partId: "part-1", stage: "thread_reply", text: "First" },
      {
        partId: "part-2",
        stage: "thread_reply_continuation",
        text: "Second",
      },
    ],
    completion: {
      turnId: "turn-1",
      inputMessageIds: ["user-1"],
      assistantMessage: {
        messageId: "assistant-1",
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
  } = {},
) {
  return createPendingConversationDelivery(fixture.sql, {
    conversationId: overrides.conversationId ?? CONVERSATION_ID,
    deliveryId: overrides.deliveryId ?? DELIVERY_ID,
    turnId: overrides.turnId ?? "turn-1",
    command: command(),
    nowMs: 1_000,
  });
}

describe("pending conversation delivery outbox", () => {
  it("validates a narrow immutable command and creates intent idempotently", async () => {
    expect(
      pendingConversationDeliveryCommandSchema.safeParse({
        ...command(),
        authorizationUrl: "https://secret.example/oauth",
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
      const events = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(CONVERSATION_ID);
      expect(
        events.filter((event) => event.data.type === "delivery_intended"),
      ).toHaveLength(1);

      await expect(
        createPendingConversationDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: "delivery:different",
          turnId: "turn-1",
          command: command(),
          nowMs: 2_000,
        }),
      ).rejects.toThrow("different pending delivery");
      expect(
        (
          await createSqlConversationEventStore(fixture.sql).loadHistory(
            CONVERSATION_ID,
          )
        ).filter((event) => event.data.type === "delivery_intended"),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed on intent and terminal idempotency-key collisions", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      await events.append(CONVERSATION_ID, [
        {
          idempotencyKey: deliveryIntentEventKey(DELIVERY_ID),
          createdAtMs: 900,
          data: { type: "mcp_provider_connected", provider: "github" },
        },
      ]);
      await expect(createDelivery(fixture)).rejects.toThrow(
        "intent idempotency key has conflicting data",
      );

      const secondConversation = "slack:C123:1718123456.000001";
      const secondDelivery = "delivery:turn-2";
      await events.append(secondConversation, [
        {
          idempotencyKey: deliveryTerminalEventKey(secondDelivery),
          createdAtMs: 900,
          data: { type: "mcp_provider_connected", provider: "github" },
        },
      ]);
      await expect(
        createPendingConversationDelivery(fixture.sql, {
          conversationId: secondConversation,
          deliveryId: secondDelivery,
          turnId: "turn-1",
          command: command(),
          nowMs: 1_000,
        }),
      ).rejects.toThrow("unexpected event type");
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
      await markPendingDeliveryPartPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease: claimed.lease!,
        nowMs: 1_002,
      });

      const recovered = await claimPendingConversationDelivery(fixture.sql, {
        deliveryId: DELIVERY_ID,
        leaseOwner: "worker-c",
        nowMs: 1_102,
        leaseDurationMs: 100,
      });
      expect(recovered?.partStates["part-1"]).toEqual({
        status: "uncertain",
        attemptedAtMs: 1_002,
        retryAtMs: 1_102,
        reconciliationAttempt: 0,
      });
      await expect(
        markPendingDeliveryPartPosting(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: recovered!.lease!,
          nowMs: 1_103,
        }),
      ).rejects.toThrow("uncertain state");
      await expect(
        markPendingDeliveryPartRepostable(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: recovered!.lease!,
          nowMs: 1_103,
          reconciliationAttempt: 1,
          confirmedAbsentAtMs: 1_103,
          graceElapsedAtMs: 1_104,
        }),
      ).rejects.toThrow("grace must be complete");
      await expect(
        markPendingDeliveryPartRepostable(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: recovered!.lease!,
          nowMs: 1_105,
          reconciliationAttempt: 1,
          confirmedAbsentAtMs: 1_104,
          graceElapsedAtMs: 1_103,
        }),
      ).rejects.toThrow("grace must be complete");
      const repostable = await markPendingDeliveryPartRepostable(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease: recovered!.lease!,
        nowMs: 1_105,
        reconciliationAttempt: 1,
        confirmedAbsentAtMs: 1_103,
        graceElapsedAtMs: 1_104,
      });
      expect(repostable.partStates["part-1"]).toEqual({ status: "pending" });
      await expect(
        markPendingDeliveryPartRepostable(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: recovered!.lease!,
          nowMs: 1_106,
          reconciliationAttempt: 0,
          confirmedAbsentAtMs: 1_103,
          graceElapsedAtMs: 1_104,
        }),
      ).rejects.toThrow("reconciliationAttempt must be positive");
      await expect(
        markPendingDeliveryPartRepostable(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: recovered!.lease!,
          nowMs: 1_106,
          reconciliationAttempt: 2,
          confirmedAbsentAtMs: 1_103,
          graceElapsedAtMs: 1_104,
        }),
      ).rejects.toThrow("pending");
      await expect(
        recordPendingDeliveryPartAccepted(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease: claimed.lease!,
          providerMessageId: "1718123457.000001",
          nowMs: 1_103,
        }),
      ).rejects.toBeInstanceOf(PendingDeliveryLeaseLostError);
    } finally {
      await fixture.close();
    }
  });

  it("persists multipart receipts, uncertainty cursor, and definitive failure", async () => {
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
      await expect(
        markPendingDeliveryPartPosting(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-2",
          lease,
          nowMs: 1_002,
        }),
      ).rejects.toThrow("current pending delivery part");
      await markPendingDeliveryPartPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease,
        nowMs: 1_002,
      });
      const uncertain = await recordPendingDeliveryPartUncertain(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease,
        nowMs: 1_003,
        retryAtMs: 1_500,
        reconciliationAttempt: 2,
        reconciliationCursor: "cursor-next-page",
      });
      expect(uncertain.partStates["part-1"]).toMatchObject({
        status: "uncertain",
        reconciliationAttempt: 2,
        reconciliationCursor: "cursor-next-page",
      });
      await expect(
        markPendingDeliveryPartRepostable(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease,
          nowMs: 1_004,
          reconciliationAttempt: 1,
          confirmedAbsentAtMs: 1_003,
          graceElapsedAtMs: 1_004,
        }),
      ).rejects.toThrow("attempt is stale");
      await markPendingDeliveryPartRepostable(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease,
        nowMs: 1_004,
        reconciliationAttempt: 2,
        confirmedAbsentAtMs: 1_003,
        graceElapsedAtMs: 1_004,
      });
      await markPendingDeliveryPartPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-1",
        lease,
        nowMs: 1_004,
      });
      const firstAccepted = await recordPendingDeliveryPartAccepted(
        fixture.sql,
        {
          deliveryId: DELIVERY_ID,
          partId: "part-1",
          lease,
          providerMessageId: "1718123457.000001",
          nowMs: 1_004,
        },
      );
      expect(firstAccepted.nextPartIndex).toBe(1);
      await markPendingDeliveryPartPosting(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-2",
        lease,
        nowMs: 1_005,
      });
      const failed = await recordPendingDeliveryPartFailed(fixture.sql, {
        deliveryId: DELIVERY_ID,
        partId: "part-2",
        lease,
        failureCode: "provider_rejected",
        nowMs: 1_006,
      });
      expect(failed.partStates["part-2"]).toEqual({
        status: "failed",
        failureCode: "provider_rejected",
        failedAtMs: 1_006,
      });
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          lease,
          nowMs: 1_007,
          finalizer: vi.fn(),
        }),
      ).rejects.toThrow("every part is accepted");

      const failureFinalizer = vi.fn();
      await expect(
        terminalizeFailedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          lease,
          nowMs: 1_008,
          finalizer: failureFinalizer,
        }),
      ).resolves.toBe("finalized");
      await expect(
        terminalizeFailedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          lease,
          nowMs: 1_009,
          finalizer: failureFinalizer,
        }),
      ).resolves.toBe("already_finalized");
      expect(failureFinalizer).toHaveBeenCalledTimes(1);
      const history = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory(CONVERSATION_ID);
      expect(
        history.filter((event) => event.data.type === "delivery_failed"),
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
      for (const [index, partId] of ["part-1", "part-2"].entries()) {
        await markPendingDeliveryPartPosting(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId,
          lease,
          nowMs: 1_010 + index * 2,
        });
        await recordPendingDeliveryPartAccepted(fixture.sql, {
          deliveryId: DELIVERY_ID,
          partId,
          lease,
          providerMessageId: `1718123457.00000${index + 1}`,
          nowMs: 1_011 + index * 2,
        });
      }

      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
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

      const finalizer = vi.fn(async () => {
        await fixture.sql
          .db()
          .update(juniorConversations)
          .set({ title: "finalized" })
          .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
      });
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
          lease,
          nowMs: 1_021,
          finalizer,
        }),
      ).resolves.toBe("finalized");
      await expect(
        terminalizeAcceptedPendingDelivery(fixture.sql, {
          conversationId: CONVERSATION_ID,
          deliveryId: DELIVERY_ID,
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
        events.filter((event) => event.data.type === "delivery_accepted"),
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
