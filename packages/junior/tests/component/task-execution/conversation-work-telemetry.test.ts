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
import { createSlackSource } from "@sentry/junior-plugin-api";
import * as Sentry from "@/chat/sentry";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import type { AgentRun } from "@/chat/agent/types";
import { closeDb } from "@/chat/db";
import { withLogContext } from "@/chat/logging";
import { withTurnSpan } from "@/chat/task-execution/turn-telemetry";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
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
  SLACK_DESTINATION,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";
import { createConversationFixture } from "../../fixtures/conversation";

/** Reply "done" without running the agent. */
const doneAgentRunner = {
  run: async (run: AgentRun) => {
    await deliverAssistantMessagesForTest(run, [{ text: "done" }]);
    return completedAgentRun({
      text: "done",
      diagnostics: {
        assistantMessageCount: 1,
        modelId: "fake-agent-model",
        outcome: "success" as const,
        toolCalls: [],
        toolErrorCount: 0,
        toolResultCount: 0,
        usedPrimaryText: true,
      },
    });
  },
};

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
        op === "http.server" ||
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

  const byOp = (op: string) =>
    spans.filter((span) => span.attributes?.["sentry.op"] === op);

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

  it("puts a dashboard turn in the trace of the request that sent it", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await Sentry.startNewTrace(() =>
      Sentry.startSpan(
        { name: "POST /api/conversations", op: "http.server" },
        () =>
          createAndEnqueueConversation(
            {
              actor,
              idempotencyKey: "telemetry-1",
              message: "Start a dashboard turn.",
            },
            { conversationStore, queue, state },
          ),
      ),
    );
    const worker = createConversationTurnWorker(doneAgentRunner);
    await consumeConversationQueueMessage(queue.takeMessage(), {
      messageId: "msg_1",
      queue,
      run: async (context) => {
        const resolved = await resolveMailboxTurnWork(context);
        if (!resolved) throw new Error("Expected Conversation mailbox work");
        return await worker(context, resolved);
      },
      state,
    });

    const [request] = byOp("http.server");
    const [workerSpan] = byOp("queue.process");
    expect(workerSpan?.trace_id).not.toBe(request?.trace_id);
    expect(byOp("chat.turn")).toEqual([
      expect.objectContaining({
        trace_id: request?.trace_id,
        parent_span_id: request?.span_id,
        attributes: expect.objectContaining({
          "gen_ai.conversation.id": accepted.conversationId,
          "app.turn.input_count": 1,
          "app.turn.wait_ms": expect.any(Number),
        }),
        links: [
          expect.objectContaining({
            trace_id: workerSpan?.trace_id,
            span_id: workerSpan?.span_id,
          }),
        ],
      }),
    ]);
  });

  it("puts a resumed slice in the trace of its first slice", async () => {
    const conversationId = "slack:C123:1712345.0001";
    const turnId = "turn_1712345_0001";
    const checkpoint = {
      conversationId,
      turnId,
      sliceId: 1,
      destination: SLACK_DESTINATION,
      source: createSlackSource({
        ...SLACK_DESTINATION,
        threadTs: "1712345.0001",
        visibility: "private",
      }),
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "original request" }],
          timestamp: 1_000,
        },
      ],
    };
    await Sentry.startNewTrace(() =>
      Sentry.startSpan({ name: "chat.turn", op: "chat.turn" }, () =>
        saveTurnCheckpoint({ ...checkpoint, mode: "running" }),
      ),
    );
    // A later save from another trace, such as lost-worker recovery.
    await Sentry.startNewTrace(() =>
      saveTurnCheckpoint({ ...checkpoint, mode: "paused", reason: "yield" }),
    );
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        messages: [
          {
            id: "1712345.0001",
            role: "user",
            text: "original request",
            createdAtMs: 1_000,
            author: { userId: "U123" },
          },
        ],
        processing: { activeTurnId: turnId },
        vision: { byFileId: {} },
      },
    });

    await Sentry.startNewTrace(() =>
      Sentry.startSpan(
        { name: "conversation.work.process", op: "queue.process" },
        () =>
          runNextPausedTurn(conversationId, { agentRunner: doneAgentRunner }),
      ),
    );

    const [first, resumed] = byOp("chat.turn");
    const [worker] = byOp("queue.process");
    expect(worker?.trace_id).not.toBe(first?.trace_id);
    expect(resumed).toMatchObject({
      trace_id: first?.trace_id,
      parent_span_id: first?.span_id,
      links: [
        expect.objectContaining({
          trace_id: worker?.trace_id,
          span_id: worker?.span_id,
        }),
      ],
    });
  });
});
