import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Sentry from "@/chat/sentry";
import { closeDb } from "@/chat/db";
import { withLogContext } from "@/chat/logging";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { consumeConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  inboundMessage,
} from "../../fixtures/conversation-work";

describe("conversation work telemetry", () => {
  const spans: ReturnType<typeof Sentry.spanToJSON>[] = [];
  let client: ReturnType<typeof Sentry.init>;

  beforeAll(() => {
    client = Sentry.init({
      dsn: "https://public@example.com/1",
      tracesSampleRate: 1,
      defaultIntegrations: false,
      transport: () => ({
        send: async () => ({ statusCode: 200 }),
        flush: async () => true,
      }),
    });
    client?.on("spanEnd", (span) => {
      const json = Sentry.spanToJSON(span);
      if (json.op === "queue.publish" || json.op === "queue.process") {
        spans.push(json);
      }
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    spans.length = 0;
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
    await disconnectStateAdapter();
  });

  it("records Sentry queue publish and process spans for one conversation wake", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    const queue = createVercelConversationWorkQueue({
      topic: "junior_test_work",
      client: { send: async () => ({ messageId: "msg_1" }) },
    });
    // Ingress binds Slack values to the same messaging attribute keys.
    await withLogContext({ platform: "slack", destinationName: "C123" }, () =>
      queue.send(conversationQueueMessage()),
    );

    // In-process consumption stamps queue send time from the clock.
    vi.useFakeTimers({ now: 4_250, toFake: ["Date"] });
    await consumeConversationQueueMessage(conversationQueueMessage(), {
      messageId: "msg_1",
      nowMs: () => 5_000,
      queue: createConversationWorkQueueTestAdapter(),
      run: async (context) => {
        await context.attempt.drain(async () => {});
        return { status: "completed" };
      },
      topic: "junior_test_work",
    });

    expect(spans).toEqual([
      expect.objectContaining({
        description: "conversation.work.publish",
        op: "queue.publish",
        data: expect.objectContaining({
          "gen_ai.conversation.id": CONVERSATION_ID,
          "messaging.destination.name": "junior_test_work",
          "messaging.message.body.size": expect.any(Number),
          "messaging.message.id": "msg_1",
          "messaging.system": "vercel_queue",
        }),
      }),
      expect.objectContaining({
        description: "conversation.work.process",
        op: "queue.process",
        data: expect.objectContaining({
          "gen_ai.conversation.id": CONVERSATION_ID,
          "messaging.destination.name": "junior_test_work",
          "messaging.message.id": "msg_1",
          "messaging.message.receive.latency": 750,
          "messaging.message.retry.count": 0,
          "messaging.system": "vercel_queue",
          "app.worker.outcome": "completed",
          "app.worker.pending_count": 1,
        }),
      }),
    ]);
  });
});
