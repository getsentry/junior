import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchRecord,
  getDispatchStorageKey,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import { recoverPendingDispatchMailboxAppends } from "@/chat/agent-dispatch/heartbeat";
import {
  createAgentDispatchConversationWorker,
  createAgentDispatchWorkRouter,
  enqueueAgentDispatch,
} from "@/chat/agent-dispatch/work";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  listAgentTurnSessionSummariesForConversation,
  recordAgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { deliverAssistantMessagesForTest } from "../fixtures/agent-runner";
import {
  agentDispatchTestDestination as destination,
  createAgentDispatchTestRecord as createDispatch,
  createAgentDispatchTestRuntime as createDispatchRuntime,
  createAgentDispatchWorkerContext as createContext,
} from "../fixtures/agent-dispatch";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("agent dispatch conversation work", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("preserves plain dispatch input without Markdown serialization", async () => {
    const input = "Post snake_case as written.\n- Keep this bullet.";
    const dispatch = await createDispatch(
      "plain-input",
      undefined,
      undefined,
      undefined,
      input,
    );
    const run = vi.fn(async (request) => {
      expect(request.input.messageText).toBe(input);
      await request.durability.onInputCommitted?.();
      const piMessages = await deliverAssistantMessagesForTest(request, [
        { text: "Done" },
      ]);
      return completedAgentRun({
        text: "Done",
        piMessages,
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      });
    });
    const runtime = createDispatchRuntime({ agentRunner: { run } });

    await runtime.runDispatchTurn(dispatch, {
      ack: vi.fn(async () => {}),
    });

    expect(run).toHaveBeenCalledOnce();
  });

  it("runs enqueued dispatch work through production routing with exact authority", async () => {
    const dispatch = await createDispatch(
      "shared-runtime",
      undefined,
      undefined,
      { label: "Scheduled task", detail: "Weekly" },
    );
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const run = vi.fn(async (request) => {
      expect(request).toMatchObject({
        conversationId: `agent-dispatch:${dispatch.id}`,
        turnId: `dispatch:${dispatch.id}`,
        routing: {
          actor: { platform: "system", name: "scheduler" },
          credentialContext: {
            actor: { platform: "system", name: "scheduler" },
          },
          destination,
          destinationVisibility: "private",
          dispatch: {
            id: dispatch.id,
            plugin: "scheduler",
            replyAttribution: {
              label: "Scheduled task",
              detail: "Weekly",
            },
          },
          surface: "api",
        },
        policy: { authorizationFlowMode: "disabled" },
      });
      await request.durability.onInputCommitted?.();
      const piMessages = await deliverAssistantMessagesForTest(request, [
        { text: "Scheduled digest" },
      ]);
      return completedAgentRun({
        text: "Scheduled digest",
        piMessages,
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      });
    });
    const runtime = createDispatchRuntime({ agentRunner: { run } });
    const dispatchWorker = createAgentDispatchConversationWorker({
      resumeTurn: vi.fn(),
      runTurn: runtime.runDispatchTurn,
    });
    const slackWorker = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const route = createAgentDispatchWorkRouter({
      dispatchWorker,
      fallbackWorker: slackWorker,
    });

    await enqueueAgentDispatch(dispatch, { queue, state });
    const queueMessage = queue.takeMessage();
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: route,
      state,
    });
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: route,
      state,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(slackWorker).not.toHaveBeenCalled();
    expect(queue.hasQueuedMessages()).toBe(false);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: destination.channelId,
      text: "Scheduled digest\n\nScheduled task · Weekly",
    });
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: expect.any(String),
      status: "completed",
    });
  });

  it("retries a transient runtime failure instead of treating it as terminal", async () => {
    const dispatch = await createDispatch("runtime-retry");
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    let runCount = 0;
    const agentRunner = {
      run: vi.fn(async (request) => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error("provider temporarily unavailable");
        }
        await request.durability.onInputCommitted?.();
        const piMessages = await deliverAssistantMessagesForTest(request, [
          { text: "Recovered scheduled digest" },
        ]);
        return completedAgentRun({
          text: "Recovered scheduled digest",
          piMessages,
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "test-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true,
          },
        });
      }),
    };
    const runtime = createDispatchRuntime({ agentRunner });
    const route = createAgentDispatchWorkRouter({
      dispatchWorker: createAgentDispatchConversationWorker({
        resumeTurn: vi.fn(),
        runTurn: runtime.runDispatchTurn,
      }),
      fallbackWorker: vi.fn(async () => ({
        status: "completed" as const,
      })),
    });

    await enqueueAgentDispatch(dispatch, { queue, state });
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run: route,
        state,
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(agentRunner.run).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "running",
    });
    await expect(
      listAgentTurnSessionSummariesForConversation(
        getDispatchConversationId(dispatch),
      ),
    ).resolves.toEqual([
      expect.not.objectContaining({ dispatchOutcome: expect.anything() }),
    ]);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run: route,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(agentRunner.run).toHaveBeenCalledTimes(2);
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: destination.channelId,
          text: "Recovered scheduled digest",
        }),
      }),
    ]);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it.each(["awaiting_resume", "running"] as const)(
    "resumes durable %s work even when recovery has mailbox input",
    async (sessionState) => {
      const dispatch = await createDispatch("cutover-resume");
      const conversationId = getDispatchConversationId(dispatch);
      const sessionId = getDispatchTurnId(dispatch.id);
      const queue = createConversationWorkQueueTestAdapter();
      const state = getStateAdapter();
      await state.connect();
      const nowMs = Date.now();
      await state.set(
        getDispatchStorageKey(dispatch.id),
        {
          ...dispatch,
          attempt: 1,
          lastCallbackAtMs: nowMs - 2_000,
          leaseExpiresAtMs: nowMs - 1_000,
          maxAttempts: 5,
          status: sessionState,
          version: 2,
        },
        JUNIOR_THREAD_STATE_TTL_MS,
      );
      await recordAgentTurnSessionSummary({
        actor: dispatch.actor,
        conversationId,
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        dispatchId: dispatch.id,
        sessionId,
        sliceId: 2,
        source: dispatch.source,
        state: sessionState,
        surface: "api",
      });
      const runTurn = vi.fn();
      const resumeTurn = vi.fn(async () => {
        await recordAgentTurnSessionSummary({
          actor: dispatch.actor,
          conversationId,
          destination: dispatch.destination,
          destinationVisibility: dispatch.destinationVisibility,
          dispatchId: dispatch.id,
          dispatchOutcome: "completed",
          sessionId,
          sliceId: 2,
          source: dispatch.source,
          state: "completed",
          surface: "api",
        });
      });
      const worker = createAgentDispatchConversationWorker({
        resumeTurn,
        runTurn,
      });

      await recoverPendingDispatchMailboxAppends({
        conversationWorkQueue: queue,
        nowMs,
      });
      expect(queue.sentRecords()).toEqual([
        {
          conversationId,
          idempotencyKey: `agent-dispatch:${dispatch.id}`,
        },
      ]);
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run: async (context) => await worker(context, dispatch.id),
        state,
      });

      expect(runTurn).not.toHaveBeenCalled();
      expect(resumeTurn).toHaveBeenCalledOnce();
      expect(queue.hasQueuedMessages()).toBe(false);
      await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
        status: "completed",
      });
    },
  );

  it("projects a previously delivered reply without running the agent again", async () => {
    const dispatch = await createDispatch("delivered-replay");
    const conversationId = getDispatchConversationId(dispatch);
    const turnId = getDispatchTurnId(dispatch.id);
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(
      {
        id: getDispatchInputMessageId(dispatch.id),
        role: "user",
        text: dispatch.input,
        createdAtMs: dispatch.createdAtMs,
        author: { isBot: true, userName: "scheduler" },
        meta: { replied: true },
      },
      {
        id: `${turnId}:assistant:1`,
        role: "assistant",
        text: "Already delivered digest",
        createdAtMs: dispatch.createdAtMs + 1,
        author: { isBot: true, userName: "junior" },
        meta: {
          replied: true,
          slackTs: "1700000000.000009",
        },
      },
    );
    await persistConversationMessages({ conversation, conversationId });
    const agentRunner = { run: vi.fn() };
    const runtime = createDispatchRuntime({ agentRunner });
    const worker = createAgentDispatchConversationWorker({
      resumeTurn: vi.fn(),
      runTurn: runtime.runDispatchTurn,
    });
    const { ack, context } = createContext(dispatch);

    await expect(worker(context, dispatch.id)).resolves.toEqual({
      status: "completed",
    });

    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000009",
      status: "completed",
    });
  });

  it("uses a durable delivery receipt when the worker died before outcome persistence", async () => {
    const dispatch = await createDispatch("delivery-receipt-fence");
    await recordAgentTurnSessionSummary({
      actor: dispatch.actor,
      conversationId: getDispatchConversationId(dispatch),
      destination: dispatch.destination,
      destinationVisibility: dispatch.destinationVisibility,
      dispatchId: dispatch.id,
      resultMessageId: "1700000000.000012",
      sessionId: getDispatchTurnId(dispatch.id),
      sliceId: 1,
      source: dispatch.source,
      state: "running",
      surface: "api",
    });
    const runTurn = vi.fn();
    const resumeTurn = vi.fn();
    const worker = createAgentDispatchConversationWorker({
      resumeTurn,
      runTurn,
    });
    const { ack, context } = createContext(dispatch);

    await expect(worker(context, dispatch.id)).resolves.toEqual({
      status: "completed",
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(resumeTurn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000012",
      status: "completed",
    });
  });

});
