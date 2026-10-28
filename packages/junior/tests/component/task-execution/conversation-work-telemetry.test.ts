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
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { consumeConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
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
      if (json.op === "conversation.work.process") {
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

  it("records queue lag, delivery count, pending messages, and outcome on the worker span", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

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
    });

    expect(spans).toEqual([
      expect.objectContaining({
        description: "conversation.work.process",
        data: expect.objectContaining({
          "gen_ai.conversation.id": CONVERSATION_ID,
          "app.queue.delivery_count": 1,
          "app.queue.lag_ms": 750,
          "app.worker.outcome": "completed",
          "app.worker.pending_count": 1,
        }),
      }),
    ]);
  });
});
