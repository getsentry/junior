import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import { getQueueProvider } from "@/chat/queue/provider";
import {
  getTurnRequestDeadline,
  runWithTurnRequestDeadline,
} from "@/chat/runtime/request-deadline";
import { signConversationQueueMessage } from "@/chat/task-execution/queue-signing";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { createVercelConversationWorkCallback } from "@/chat/task-execution/vercel-callback";
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
import { useConfig } from "../../fixtures/config";

// Chat config reads the queue API URL when it loads, so pick the port first.
// Each test starts its own local queue server on this port.
const { port, previousQueueApiUrl } = await vi.hoisted(async () => {
  const { createServer: createPortProbe } = await import("node:net");
  const probe = createPortProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("No free port for the local queue server");
  }
  const previousQueueApiUrl = process.env["JUNIOR_QUEUE_API_URL"];
  process.env["JUNIOR_QUEUE_API_URL"] = `http://127.0.0.1:${address.port}`;
  return { port: address.port, previousQueueApiUrl };
});

// Later test files in this worker read chat config again.
afterAll(() => {
  if (previousQueueApiUrl === undefined) {
    delete process.env["JUNIOR_QUEUE_API_URL"];
  } else {
    process.env["JUNIOR_QUEUE_API_URL"] = previousQueueApiUrl;
  }
});

let server: LocalVercelQueueServer | undefined;

/**
 * Push conversation work through the real callback route. `deliver` wraps
 * each push, so a test can run it inside another request's context.
 */
async function startAckingConsumer(
  deliver: (push: () => Promise<Response>) => Promise<Response> = (push) =>
    push(),
) {
  const fixture = await createConversationFixture();
  const run = vi.fn(async (context: ConversationWorkerContext) => {
    await context.attempt.ack();
    return { status: "completed" as const };
  });
  const callback = createVercelConversationWorkCallback({
    conversationStore: fixture.conversationStore,
    queue: fixture.queue,
    run,
    state: fixture.state,
  });
  const topic = `junior_test_conversation_work_${randomUUID()}`;
  const url = `http://app.localhost/api/queue/${topic}`;
  let pushes = 0;
  server = await startLocalVercelQueueServer({
    consumers: [{ consumerGroup: "local", topic, url }],
    fetch: async (request) => {
      const response = await deliver(() => callback(request));
      pushes += 1;
      return response;
    },
    // The SDK leases each message for at least 30 seconds.
    maxLeaseSeconds: 1,
    port,
  });
  return {
    fixture,
    pushes: () => pushes,
    run,
    send: (payload: unknown) => getQueueProvider().send(topic, payload),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for queue delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("conversation work queue consumer", () => {
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await closeConversationFixture();
    vi.unstubAllEnvs();
  });

  it("acks unsigned messages, runs signed ones, and retries when the secret is missing", async () => {
    const consumer = await startAckingConsumer();

    // An unsigned message is acknowledged once and never runs.
    await consumer.send({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
    await waitFor(() => consumer.pushes() === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(consumer.pushes()).toBe(1);
    expect(consumer.run).not.toHaveBeenCalled();

    useConfig({ secrets: { juniorSecret: "conversation-work-secret" } });
    await appendInboundMessage({
      conversationStore: consumer.fixture.conversationStore,
      message: inboundMessage("m1", { delivery: "defer" }),
      nowMs: 1_200,
      state: consumer.fixture.state,
    });
    await consumer.send(
      signConversationQueueMessage(conversationQueueMessage()),
    );
    await waitFor(() => consumer.run.mock.calls.length > 0);
    expect(consumer.run).toHaveBeenCalledOnce();
    expect(consumer.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ destination: SLACK_DESTINATION }),
    );

    // Without the secret, the message cannot be checked, so it is pushed
    // again and does not run.
    vi.stubEnv("JUNIOR_SECRET", undefined);
    useConfig();
    const pushesBefore = consumer.pushes();
    await consumer.send({
      ...conversationQueueMessage(),
      signature: "signature",
      signatureVersion: "v2",
      signedAtMs: 1_000,
    });
    await waitFor(() => consumer.pushes() >= pushesBefore + 2);
    expect(consumer.run).toHaveBeenCalledOnce();
  }, 15_000);

  it("gives each delivery its own request deadline", async () => {
    // Deliver inside another request whose deadline passed an hour ago.
    const consumer = await startAckingConsumer((push) =>
      runWithTurnRequestDeadline(push, Date.now() - 3_600_000),
    );
    let deliveryDeadlineAtMs: number | undefined;
    consumer.run.mockImplementationOnce(async (context) => {
      deliveryDeadlineAtMs = getTurnRequestDeadline()?.deadlineAtMs;
      await context.attempt.ack();
      return { status: "completed" as const };
    });

    useConfig({ secrets: { juniorSecret: "conversation-work-secret" } });
    await appendInboundMessage({
      conversationStore: consumer.fixture.conversationStore,
      message: inboundMessage("m1", { delivery: "defer" }),
      nowMs: 1_200,
      state: consumer.fixture.state,
    });
    await consumer.send(
      signConversationQueueMessage(conversationQueueMessage()),
    );
    await waitFor(() => consumer.run.mock.calls.length > 0);

    expect(consumer.run).toHaveBeenCalledOnce();
    expect(deliveryDeadlineAtMs).toBeGreaterThan(Date.now());
  });
});
