import {
  appendInboundMessage,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import {
  signConversationQueueMessage,
  verifySignedConversationQueueMessage,
} from "@/chat/task-execution/queue-signing";
import { describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_ID,
  OTHER_SLACK_DESTINATION,
  SLACK_DESTINATION,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  inboundMessage,
} from "../../fixtures/conversation-work";
import { stubTestEnv, useMemoryStateAdapter } from "../../fixtures/vitest";

describe("conversation work queue contract", () => {
  useMemoryStateAdapter();

  it("deduplicates accepted fake queue payloads by idempotency key", async () => {
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      queue.send(conversationQueueMessage(), { idempotencyKey: "m1" }),
    ).resolves.toEqual({ messageId: "queue-1" });
    await expect(
      queue.send(conversationQueueMessage(), { idempotencyKey: "m1" }),
    ).resolves.toEqual({ messageId: "queue-1" });

    expect(queue.sendAttempts()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
    ]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
    ]);
    expect(queue.queuedMessages()).toEqual([conversationQueueMessage()]);
  });

  it("maps the generic queue port to Vercel Queue send options", async () => {
    stubTestEnv({ JUNIOR_SECRET: "conversation-work-secret" });
    const sends: Array<{
      message: unknown;
      options: unknown;
      topic: string;
    }> = [];
    const queue = createVercelConversationWorkQueue({
      topic: "junior_test_work",
      client: {
        async send(topic, message, options) {
          sends.push({ topic, message, options });
          return { messageId: "msg_123" };
        },
      },
    });

    await expect(
      queue.send(
        conversationQueueMessage(),
        { delayMs: 15_001, idempotencyKey: "idem-1" },
      ),
    ).resolves.toEqual({ messageId: "msg_123" });

    expect(sends).toEqual([
      {
        topic: "junior_test_work",
        message: expect.objectContaining({
          conversationId: CONVERSATION_ID,
          destination: SLACK_DESTINATION,
          signature: expect.any(String),
          signatureVersion: "v1",
          signedAtMs: expect.any(Number),
        }),
        options: {
          delaySeconds: 16,
          idempotencyKey: "idem-1",
          retentionSeconds: undefined,
        },
      },
    ]);
  });

  it("rejects queue messages whose destination does not match persisted work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const run = vi.fn(async () => ({ status: "completed" as const }));
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationQueueMessage(
        conversationQueueMessage({ destination: OTHER_SLACK_DESTINATION }),
        {
          queue,
          run,
        },
      ),
    ).rejects.toThrow("Conversation work queue destination changed");

    expect(run).not.toHaveBeenCalled();
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({
      destination: SLACK_DESTINATION,
      lease: undefined,
    });
  });

  it("verifies signed Vercel Queue callback payloads", () => {
    stubTestEnv({ JUNIOR_SECRET: "conversation-work-secret" });
    const signedAtMs = 12_345;
    const maxSkewMs = 60 * 60 * 1000;
    const signed = signConversationQueueMessage(
      conversationQueueMessage(),
      signedAtMs,
    );

    expect(verifySignedConversationQueueMessage(signed, signedAtMs)).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
    expect(
      verifySignedConversationQueueMessage(
        {
          ...signed,
          conversationId: "slack:C123:forged",
        },
        signedAtMs,
      ),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(
        {
          ...signed,
          signature: "deadbeef",
        },
        signedAtMs,
      ),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs + maxSkewMs + 1),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs - maxSkewMs - 1),
    ).toBeUndefined();
  });

  it("signs queue destinations by identity rather than object key order", () => {
    stubTestEnv({ JUNIOR_SECRET: "conversation-work-secret" });
    const signedAtMs = 12_345;
    const signed = signConversationQueueMessage(
      {
        conversationId: CONVERSATION_ID,
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
      },
      signedAtMs,
    );

    expect(verifySignedConversationQueueMessage(signed, signedAtMs)).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
  });

  it("keeps queue signatures valid across default visibility redelivery", () => {
    stubTestEnv({ JUNIOR_SECRET: "conversation-work-secret" });
    const signedAtMs = 12_345;
    const signed = signConversationQueueMessage(
      conversationQueueMessage(),
      signedAtMs,
    );

    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs + 330_000),
    ).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
  });

  it("processes Vercel Queue payloads through the leased worker", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[] = [];

    await expect(
      processConversationQueueMessage(
        conversationQueueMessage(),
        {
          queue,
          run: async (context) => {
            const messages = await context.drainMailbox(async () => {});
            injected.push(
              ...messages.map((message) => message.inboundMessageId),
            );
            return { status: "completed" };
          },
        },
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual(["m1"]);
  });

  it("rejects malformed Vercel Queue payloads", async () => {
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      processConversationQueueMessage(
        { wrong: CONVERSATION_ID },
        {
          queue,
          run: async () => ({ status: "completed" }),
        },
      ),
    ).rejects.toThrow("missing destination context");
  });
});
