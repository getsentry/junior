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
import { withTurnSpan } from "@/chat/providers/slack/turn-input-telemetry";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { appendInboundMessage } from "@/chat/task-execution/store";
import { consumeConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  inboundMessage,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
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
      const op = json.attributes?.["sentry.op"];
      if (
        op === "queue.publish" ||
        op === "queue.process" ||
        op === "slack.message.ingress" ||
        op === "chat.turn"
      ) {
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
        name: "conversation.work.publish",
        attributes: expect.objectContaining({
          "sentry.op": "queue.publish",
          "gen_ai.conversation.id": CONVERSATION_ID,
          "messaging.destination.name": "junior_test_work",
          "messaging.message.body.size": expect.any(Number),
          "messaging.message.id": "msg_1",
          "messaging.system": "vercel_queue",
        }),
      }),
      expect.objectContaining({
        name: "conversation.work.process",
        attributes: expect.objectContaining({
          "sentry.op": "queue.process",
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

  it("puts a Slack turn in the ingress trace of its oldest input", async () => {
    const state = getStateAdapter();
    await state.connect();
    const queue = createConversationWorkQueueTestAdapter();
    const adapter = createSlackAdapterFixture();
    // Each Slack webhook request starts its own trace.
    for (const ts of ["1712345.0001", "1712345.0002"]) {
      await Sentry.startNewTrace(() =>
        handleSlackWebhookAndFlush({
          request: slackWebhookRequest(
            slackEnvelope({
              text: `<@${SLACK_BOT_USER_ID}> check`,
              threadTs: "1712345.0001",
              ts,
            }),
          ),
          services: {
            getSlackAdapter: () => adapter,
            queue,
            runtime: createNoopSlackWebhookRuntime(),
            state,
          },
        }),
      );
    }
    await consumeConversationQueueMessage(queue.takeMessage(), {
      messageId: "msg_1",
      queue,
      run: createSlackConversationWorker({
        getSlackAdapter: () => adapter,
        runNextPausedTurn: async () => false,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) =>
            await withTurnSpan({}, hooks.telemetry, async () => {
              await hooks.ack?.();
            }),
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
      state,
    });

    const byOp = (op: string) =>
      spans.filter((span) => span.attributes?.["sentry.op"] === op);
    const [oldest, newest] = byOp("slack.message.ingress");
    const [worker] = byOp("queue.process");
    expect(oldest?.trace_id).not.toBe(newest?.trace_id);
    expect(worker?.trace_id).not.toBe(oldest?.trace_id);
    expect(byOp("chat.turn")).toEqual([
      expect.objectContaining({
        trace_id: oldest?.trace_id,
        parent_span_id: oldest?.span_id,
        links: [
          expect.objectContaining({
            trace_id: newest?.trace_id,
            span_id: newest?.span_id,
          }),
          expect.objectContaining({
            trace_id: worker?.trace_id,
            span_id: worker?.span_id,
          }),
        ],
      }),
    ]);
  });
});
