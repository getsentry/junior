import { describe, expect, it, vi } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import {
  claimPendingConversationDelivery,
  loadPendingDeliveryByTurn,
} from "@/chat/slack/delivery-outbox";
import {
  RecoverableSlackDeliveryService,
  type RecoverableSlackDeliveryPort,
} from "@/chat/slack/recoverable-delivery";
import type { PendingConversationDeliveryCommandDraft } from "@/chat/slack/delivery-command";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";
import type { JuniorSqlDatabase } from "@/db/db";
import type { ConversationModelMessage } from "@/chat/conversations/model-message";
import type { PiMessage } from "@/chat/pi/messages";
import { commitMessages } from "@/chat/conversations/projection";
import { projectConversationEvents } from "@/chat/pi/conversation-events";

const conversationId = "slack:C123:1718123456.000000";

function command(
  parts = ["First", "Second"],
): PendingConversationDeliveryCommandDraft {
  return {
    publicLocator: "0123456789Abcdefgh_-XY",
    route: { channelId: "C123", threadTs: "1718123456.000000" },
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
      startedAtMs: 900,
    },
    parts: parts.map((text) => ({
      text,
      blocks: [{ type: "markdown", text }],
    })),
    completion: {
      turnId: "turn-1",
      inputMessageIds: ["user-1"],
      assistantMessage: {
        messageId: "assistant:turn-1",
        text: parts.join("\n"),
        createdAtMs: 950,
        author: { userName: "junior-test", isBot: true },
      },
      model: {
        modelId: "openai/gpt-5.4",
      },
      sliceId: 1,
      terminal: { outcome: "success" },
    },
  };
}

async function setup(port: RecoverableSlackDeliveryPort) {
  const fixture = await createLocalJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  await createSqlConversationMessageStore(fixture.sql).record(conversationId, [
    {
      messageId: "user-1",
      role: "user",
      text: "Question",
      createdAtMs: 900,
    },
  ]);
  const priorModelMessages = [
    { role: "user", content: [{ type: "text", text: "Question" }] },
  ] as unknown as PiMessage[];
  await commitMessages({
    conversationId,
    modelId: "openai/gpt-5.4",
    messages: priorModelMessages,
    executor: fixture.sql,
  });
  let nowMs = 1_000;
  const service = new RecoverableSlackDeliveryService(
    fixture.sql,
    port,
    () => nowMs,
  );
  const pending = await service.createIntent({
    conversationId,
    deliveryId: "slack:turn-1",
    turnId: "turn-1",
    command: command(),
    modelMessages: [
      ...priorModelMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "First\nSecond" }],
      },
    ] as unknown as ConversationModelMessage[],
  });
  return {
    fixture,
    pending,
    service,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

describe("recoverable Slack delivery", () => {
  it("rejects an empty transcript when retrying a nonempty intent", async () => {
    const test = await setup({ post: vi.fn(), reconcile: vi.fn() });
    try {
      await expect(
        test.service.createIntent({
          conversationId,
          deliveryId: "slack:turn-1",
          turnId: "turn-1",
          command: command(),
          modelMessages: [],
        }),
      ).rejects.toThrow("Pending delivery command does not match its intent");
    } finally {
      await test.fixture.close();
    }
  });

  it("posts multipart once and atomically finalizes the accepted turn", async () => {
    let posted = 0;
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(async () => ({
        outcome: "accepted" as const,
        ts: `1718123457.00000${++posted}` as never,
      })),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    try {
      expect(test.pending.command.completion.model).toEqual({
        modelId: "openai/gpt-5.4",
        committedSeq: expect.any(Number),
        rollbackSeq: expect.any(Number),
      });
      expect(test.pending.command.completion.model).not.toHaveProperty(
        "messages",
      );
      expect(
        (
          await createSqlConversationEventStore(test.fixture.sql).loadHistory(
            conversationId,
          )
        ).filter((event) => event.data.type === "message"),
      ).toHaveLength(2);
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "accepted",
        messageTs: "1718123457.000002",
      });
      expect(port.post).toHaveBeenCalledTimes(2);
      expect(port.reconcile).not.toHaveBeenCalled();
      expect(
        await loadPendingDeliveryByTurn(test.fixture.sql, {
          conversationId,
          turnId: "turn-1",
        }),
      ).toBeUndefined();
      const history = await createSqlConversationEventStore(
        test.fixture.sql,
      ).loadHistory(conversationId);
      expect(
        history.filter(
          (event) =>
            event.data.type === "visible_message_recorded" &&
            event.data.messageId === "assistant:turn-1",
        ),
      ).toHaveLength(1);
      expect(
        history.filter((event) => event.data.type === "turn_completed"),
      ).toHaveLength(1);
      expect(
        history.filter((event) => event.data.type === "message"),
      ).toHaveLength(2);
      await expect(
        test.service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "visible_assistant",
        }),
      ).resolves.toEqual({
        deliveryOutcome: "accepted",
        modelSucceeded: true,
      });
    } finally {
      await test.fixture.close();
    }
  });

  it("retains accepted intent when pre-terminal repair crashes", async () => {
    let posted = 0;
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(async () => ({
        outcome: "accepted" as const,
        ts: `1718123457.00000${++posted}` as never,
      })),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    const repair = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("repair crashed"))
      .mockResolvedValue(undefined);
    try {
      await expect(
        test.service.advance(test.pending, {
          beforeTerminalize: repair,
        }),
      ).rejects.toThrow("repair crashed");
      const retained = await test.service.loadByTurn({
        conversationId,
        turnId: "turn-1",
      });
      expect(retained?.progress.acceptedPartCount).toBe(2);
      expect(
        await test.service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "known_outbox_intent",
        }),
      ).toBeUndefined();

      await expect(
        test.service.advance(retained!, { beforeTerminalize: repair }),
      ).resolves.toEqual({
        outcome: "accepted",
        messageTs: "1718123457.000002",
      });
      expect(port.post).toHaveBeenCalledTimes(2);
      expect(repair).toHaveBeenCalledTimes(2);
      await expect(
        test.service.loadByTurn({ conversationId, turnId: "turn-1" }),
      ).resolves.toBeUndefined();
    } finally {
      await test.fixture.close();
    }
  });

  it("reconciles an ambiguous accepted write without reposting part one", async () => {
    const post = vi
      .fn<RecoverableSlackDeliveryPort["post"]>()
      .mockResolvedValueOnce({
        outcome: "uncertain",
        reason: "transport_error",
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        ts: "1718123457.000002" as never,
      });
    const reconcile = vi
      .fn<RecoverableSlackDeliveryPort["reconcile"]>()
      .mockResolvedValue({
        outcome: "accepted",
        ts: "1718123457.000001" as never,
      });
    const test = await setup({ post, reconcile });
    try {
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "pending",
        retryAtMs: 6_000,
      });
      test.setNow(6_000);
      const pending = await test.service.loadByTurn({
        conversationId,
        turnId: "turn-1",
      });
      await expect(test.service.advance(pending!)).resolves.toEqual({
        outcome: "accepted",
        messageTs: "1718123457.000002",
      });
      expect(post).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      await test.fixture.close();
    }
  });

  it("waits a grace after first absence and performs a fresh scan before repost", async () => {
    const post = vi
      .fn<RecoverableSlackDeliveryPort["post"]>()
      .mockResolvedValueOnce({
        outcome: "uncertain",
        reason: "transport_error",
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        ts: "1718123457.000001" as never,
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        ts: "1718123457.000002" as never,
      });
    const reconcile = vi
      .fn<RecoverableSlackDeliveryPort["reconcile"]>()
      .mockResolvedValue({ outcome: "confirmed_absent" });
    const test = await setup({ post, reconcile });
    try {
      await test.service.advance(test.pending);
      test.setNow(6_000);
      await test.service.advance(
        (await test.service.loadByTurn({ conversationId, turnId: "turn-1" }))!,
      );
      expect(post).toHaveBeenCalledTimes(1);
      test.setNow(36_000);
      await expect(
        test.service.advance(
          (await test.service.loadByTurn({
            conversationId,
            turnId: "turn-1",
          }))!,
        ),
      ).resolves.toEqual({
        outcome: "accepted",
        messageTs: "1718123457.000002",
      });
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile.mock.calls[1]?.[0]).not.toHaveProperty("cursor");
      expect(reconcile.mock.calls[0]?.[0].oldestTs).toBe("0.000000");
      expect(post).toHaveBeenCalledTimes(3);
    } finally {
      await test.fixture.close();
    }
  });

  it("keeps rate-limited writes pending without reconciliation", async () => {
    const post = vi
      .fn<RecoverableSlackDeliveryPort["post"]>()
      .mockResolvedValue({
        outcome: "retryable_absence",
        reason: "rate_limited",
        retryAtMs: 61_000,
      });
    const reconcile = vi.fn<RecoverableSlackDeliveryPort["reconcile"]>();
    const test = await setup({ post, reconcile });
    try {
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "pending",
        retryAtMs: 61_000,
      });
      const pending = await test.service.loadByTurn({
        conversationId,
        turnId: "turn-1",
      });
      expect(pending?.progress.currentState).toEqual({ status: "pending" });
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await test.fixture.close();
    }
  });

  it("honors reconciliation Retry-After without a fixed-delay loop", async () => {
    const post = vi
      .fn<RecoverableSlackDeliveryPort["post"]>()
      .mockResolvedValue({ outcome: "uncertain", reason: "transport_error" });
    const reconcile = vi
      .fn<RecoverableSlackDeliveryPort["reconcile"]>()
      .mockResolvedValue({ outcome: "retryable", retryAtMs: 90_000 });
    const test = await setup({ post, reconcile });
    try {
      await test.service.advance(test.pending);
      test.setNow(6_000);
      await expect(
        test.service.advance(
          (await test.service.loadByTurn({
            conversationId,
            turnId: "turn-1",
          }))!,
        ),
      ).resolves.toEqual({ outcome: "pending", retryAtMs: 90_000 });
      expect(reconcile).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
    } finally {
      await test.fixture.close();
    }
  });

  it("backs off permanent reconciliation failures without authorizing a repost", async () => {
    const post = vi
      .fn<RecoverableSlackDeliveryPort["post"]>()
      .mockResolvedValue({ outcome: "uncertain", reason: "transport_error" });
    const reconcile = vi
      .fn<RecoverableSlackDeliveryPort["reconcile"]>()
      .mockResolvedValue({
        outcome: "unresolved",
        reason: "permanent_provider_error",
        providerErrorCode: "missing_scope",
      });
    const test = await setup({ post, reconcile });
    try {
      await test.service.advance(test.pending);
      test.setNow(6_000);
      await expect(
        test.service.advance(
          (await test.service.loadByTurn({
            conversationId,
            turnId: "turn-1",
          }))!,
        ),
      ).resolves.toEqual({
        outcome: "pending",
        retryAtMs: 3_606_000,
      });
      const pending = await test.service.loadByTurn({
        conversationId,
        turnId: "turn-1",
      });
      expect(pending?.progress.currentState.status).toBe("uncertain");
      expect(pending?.nextAttemptAtMs).toBe(3_606_000);
      test.setNow(11_000);
      await expect(test.service.advance(pending!)).resolves.toEqual({
        outcome: "pending",
        retryAtMs: 3_606_000,
      });
      expect(post).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledOnce();
    } finally {
      await test.fixture.close();
    }
  });

  it("defers behind an active lease until the lease expires", async () => {
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    try {
      const claimed = await claimPendingConversationDelivery(test.fixture.sql, {
        deliveryId: test.pending.deliveryId,
        leaseOwner: "other-worker",
        nowMs: 1_001,
        leaseDurationMs: 59_999,
      });
      expect(claimed?.lease?.expiresAtMs).toBe(61_000);
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "pending",
        retryAtMs: 61_000,
      });
      expect(port.post).not.toHaveBeenCalled();
    } finally {
      await test.fixture.close();
    }
  });

  it("terminally fails a permanent provider rejection without persisting the assistant", async () => {
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(async () => ({
        outcome: "definitive_failure" as const,
        reason: "api_rejected" as const,
      })),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    try {
      await createSqlConversationEventStore(test.fixture.sql).append(
        conversationId,
        [
          {
            data: {
              type: "authorization_completed",
              kind: "mcp",
              provider: "linear",
              actorId: "U123",
              authorizationId: "auth-1",
            },
            createdAtMs: 1_001,
          },
        ],
      );
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "failed",
      });
      const history = await createSqlConversationEventStore(
        test.fixture.sql,
      ).loadHistory(conversationId);
      expect(
        history.filter(
          (event) =>
            event.data.type === "turn_failed" &&
            event.data.failureCode === "delivery_failed",
        ),
      ).toHaveLength(1);
      expect(
        history.some(
          (event) =>
            event.data.type === "visible_message_recorded" &&
            event.data.messageId === "assistant:turn-1",
        ),
      ).toBe(false);
      expect(
        history.filter((event) => event.data.type === "message"),
      ).toHaveLength(4);
      expect(
        projectConversationEvents(
          await createSqlConversationEventStore(
            test.fixture.sql,
          ).loadCurrentEpoch(conversationId),
        ).messages,
      ).toEqual([
        { role: "user", content: [{ type: "text", text: "Question" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'MCP authorization completed for provider "linear". Continue the blocked request and retry the provider operation if needed.',
            },
          ],
          timestamp: 1_001,
        },
      ]);
      await expect(
        test.service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "visible_assistant",
        }),
      ).resolves.toEqual({
        deliveryOutcome: "failed",
        modelSucceeded: false,
      });
      expect(
        history.some(
          (event) =>
            event.data.type === "visible_message_replied" &&
            event.data.messageId === "user-1",
        ),
      ).toBe(false);
    } finally {
      await test.fixture.close();
    }
  });

  it("retains model continuity when Slack accepted part of a failed multipart reply", async () => {
    let attempt = 0;
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? ({
              outcome: "accepted",
              ts: "1718123457.000001" as never,
            } as const)
          : ({
              outcome: "definitive_failure",
              reason: "api_rejected",
            } as const);
      }),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    try {
      await expect(test.service.advance(test.pending)).resolves.toEqual({
        outcome: "failed",
      });
      expect(
        projectConversationEvents(
          await createSqlConversationEventStore(
            test.fixture.sql,
          ).loadCurrentEpoch(conversationId),
        ).messages,
      ).toEqual([
        { role: "user", content: [{ type: "text", text: "Question" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "First\nSecond" }],
        },
      ]);
      expect(
        await createSqlConversationEventStore(test.fixture.sql).loadHistory(
          conversationId,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              type: "visible_message_recorded",
              role: "assistant",
              text: "First",
            }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              type: "turn_failed",
              failureCode: "delivery_failed",
            }),
          }),
        ]),
      );
    } finally {
      await test.fixture.close();
    }
  });

  it("maps a lost terminal commit acknowledgement from the authoritative fact", async () => {
    const port: RecoverableSlackDeliveryPort = {
      post: vi.fn(async () => ({
        outcome: "accepted" as const,
        ts: "1718123457.000001" as never,
      })),
      reconcile: vi.fn(),
    };
    const test = await setup(port);
    let lockDepth = 0;
    let injected = false;
    const sql: JuniorSqlDatabase = {
      db: () => test.fixture.sql.db(),
      transaction: (callback) => test.fixture.sql.transaction(callback),
      withLock: async (name, callback) => {
        lockDepth += 1;
        try {
          const result = await test.fixture.sql.withLock(name, callback);
          if (lockDepth === 1 && !injected) {
            const terminal = (
              await createSqlConversationEventStore(
                test.fixture.sql,
              ).loadHistory(conversationId)
            ).some((event) => event.data.type === "turn_completed");
            if (terminal) {
              injected = true;
              throw new Error("commit acknowledgement lost");
            }
          }
          return result;
        } finally {
          lockDepth -= 1;
        }
      },
    };
    const service = new RecoverableSlackDeliveryService(sql, port, () => 1_001);
    try {
      await expect(service.advance(test.pending)).resolves.toEqual({
        outcome: "accepted",
      });
      expect(injected).toBe(true);
      await expect(
        service.loadByTurn({ conversationId, turnId: test.pending.turnId }),
      ).resolves.toBeUndefined();
      expect(
        await service.loadTerminalOutcome({
          conversationId,
          turnId: test.pending.turnId,
          acceptanceEvidence: "visible_assistant",
        }),
      ).toEqual({ deliveryOutcome: "accepted", modelSucceeded: true });
    } finally {
      await test.fixture.close();
    }
  });

  it("requires assistant evidence at startup while known-intent recovery trusts the terminal", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const events = createSqlConversationEventStore(fixture.sql);
    const service = new RecoverableSlackDeliveryService(
      fixture.sql,
      { post: vi.fn(), reconcile: vi.fn() },
      () => 1_000,
    );
    try {
      await new ConversationTurnLifecycleService(events).fail({
        conversationId,
        turnId: "turn-1",
        createdAtMs: 1_000,
        failureCode: "agent_run_failed",
      });

      await expect(
        service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "visible_assistant",
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "known_outbox_intent",
        }),
      ).resolves.toEqual({
        deliveryOutcome: "accepted",
        modelSucceeded: false,
      });

      await createSqlConversationMessageStore(fixture.sql).record(
        conversationId,
        [
          {
            messageId: "assistant:turn-1",
            role: "assistant",
            text: "Fallback response",
            createdAtMs: 1_001,
          },
        ],
      );
      await expect(
        service.loadTerminalOutcome({
          conversationId,
          turnId: "turn-1",
          acceptanceEvidence: "visible_assistant",
        }),
      ).resolves.toEqual({
        deliveryOutcome: "accepted",
        modelSucceeded: false,
      });
    } finally {
      await fixture.close();
    }
  });
});
