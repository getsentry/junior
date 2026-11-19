import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueMessageMetadata } from "@/chat/queue/provider";
import {
  getTurnRequestDeadline,
  runWithTurnRequestDeadline,
} from "@/chat/runtime/request-deadline";
import { signConversationQueueMessage } from "@/chat/task-execution/queue-signing";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { conversationWorkQueueConsumer } from "@/chat/task-execution/vercel-callback";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../fixtures/conversation";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  conversationQueueMessage,
  inboundMessage,
} from "../../fixtures/conversation-work";

const metadata: QueueMessageMetadata = {
  consumerGroup: "consumer",
  createdAt: new Date(1_000),
  deliveryCount: 3,
  messageId: "msg_1",
  topicName: "topic",
};

const originalJuniorSecret = process.env["JUNIOR_SECRET"];

async function ackingConsumer() {
  const fixture = await createConversationFixture();
  const run = vi.fn(async (context: ConversationWorkerContext) => {
    await context.attempt.ack();
    return { status: "completed" as const };
  });
  const consumer = conversationWorkQueueConsumer({
    conversationStore: fixture.conversationStore,
    queue: fixture.queue,
    run,
    state: fixture.state,
  });
  return { consumer, fixture, run };
}

describe("conversation work queue consumer", () => {
  afterEach(async () => {
    await closeConversationFixture();
    if (originalJuniorSecret === undefined) {
      delete process.env["JUNIOR_SECRET"];
    } else {
      process.env["JUNIOR_SECRET"] = originalJuniorSecret;
    }
  });

  it("runs only signed messages and retries when the secret is missing", async () => {
    const { consumer, fixture, run } = await ackingConsumer();

    await expect(
      consumer.handler(
        { conversationId: CONVERSATION_ID, destination: SLACK_DESTINATION },
        metadata,
      ),
    ).resolves.toBeUndefined();

    process.env["JUNIOR_SECRET"] = "conversation-work-secret";
    await appendInboundMessage({
      conversationStore: fixture.conversationStore,
      message: inboundMessage("m1", { delivery: "defer" }),
      nowMs: 1_200,
      state: fixture.state,
    });
    await expect(
      consumer.handler(
        signConversationQueueMessage(conversationQueueMessage()),
        metadata,
      ),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ destination: SLACK_DESTINATION }),
    );

    delete process.env["JUNIOR_SECRET"];
    const missingSecretError = await consumer
      .handler(
        {
          ...conversationQueueMessage(),
          signature: "signature",
          signatureVersion: "v2",
          signedAtMs: 1_000,
        },
        metadata,
      )
      .catch((error: unknown) => error);
    expect(missingSecretError).toMatchObject({
      message: "Queue message verification unavailable: missing_secret",
    });
    expect(consumer.retry(missingSecretError, metadata)).toBeUndefined();
    expect(
      consumer.retry(new Error("runner failed"), metadata),
    ).toBeUndefined();
  });

  it("gives each delivery its own request deadline", async () => {
    const { consumer, fixture, run } = await ackingConsumer();
    let deliveryDeadlineAtMs: number | undefined;
    run.mockImplementationOnce(async (context) => {
      deliveryDeadlineAtMs = getTurnRequestDeadline()?.deadlineAtMs;
      await context.attempt.ack();
      return { status: "completed" as const };
    });

    process.env["JUNIOR_SECRET"] = "conversation-work-secret";
    await appendInboundMessage({
      conversationStore: fixture.conversationStore,
      message: inboundMessage("m1", { delivery: "defer" }),
      nowMs: 1_200,
      state: fixture.state,
    });

    // The Vercel local-dev consumer runs inside the sender's async context.
    // Here that sender's request deadline passed an hour ago.
    await runWithTurnRequestDeadline(
      () =>
        consumer.handler(
          signConversationQueueMessage(conversationQueueMessage()),
          metadata,
        ),
      Date.now() - 3_600_000,
    );

    expect(run).toHaveBeenCalledOnce();
    expect(deliveryDeadlineAtMs).toBeGreaterThan(Date.now());
  });
});
