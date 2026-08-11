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
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { recordTurnSummary } from "@/chat/task-execution/turn-cursor";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getUserMessageInstructionText } from "@/chat/pi/transcript";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { createModelStream } from "../fixtures/model-stream";
import {
  agentDispatchTestDestination as destination,
  createAgentDispatchModelHarness as createModelHarness,
  createAgentDispatchTestRecord as createDispatch,
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
    const modelStream = vi.fn(
      createModelStream([{ type: "text", text: "Done" }]),
    );
    const { runtime } = createModelHarness(modelStream);

    await runtime.runDispatchTurn(dispatch, {
      ack: vi.fn(async () => {}),
    });

    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ text: "Done" }),
      }),
    ]);
    expect(modelStream).toHaveBeenCalledOnce();
    const instruction = modelStream.mock.calls[0]?.[1].messages.at(-1);
    if (!instruction) {
      throw new Error("Expected one model instruction");
    }
    expect(getUserMessageInstructionText(instruction)).toMatchInlineSnapshot(`
      "Post snake_case as written.
      - Keep this bullet."
    `);
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
    const { agentRunner, runtime } = createModelHarness(
      createModelStream([{ type: "text", text: "Scheduled digest" }]),
    );
    const run = vi.spyOn(agentRunner, "run");
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
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      conversationId: `agent-dispatch:${dispatch.id}`,
      turnId: `dispatch:${dispatch.id}`,
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
      disabledFeatures: ["interactive-auth"],
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
      await recordTurnSummary({
        actor: dispatch.actor,
        conversationId,
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        dispatchId: dispatch.id,
        turnId: sessionId,
        sliceId: 2,
        source: dispatch.source,
        // Turn checkpoint status (dispatch status above stays SQL-bound).
        state: sessionState === "awaiting_resume" ? "paused" : sessionState,
        surface: "api",
      });
      const runTurn = vi.fn();
      const resumeTurn = vi.fn(async () => {
        await recordTurnSummary({
          actor: dispatch.actor,
          conversationId,
          destination: dispatch.destination,
          destinationVisibility: dispatch.destinationVisibility,
          dispatchId: dispatch.id,
          dispatchOutcome: "completed",
          turnId: sessionId,
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
    const { agentRunner, runtime } = createModelHarness(
      createModelStream([{ type: "text", text: "Unexpected reply" }]),
    );
    const run = vi.spyOn(agentRunner, "run");
    const worker = createAgentDispatchConversationWorker({
      resumeTurn: vi.fn(),
      runTurn: runtime.runDispatchTurn,
    });
    const { ack, context } = createContext(dispatch);

    await expect(worker(context, dispatch.id)).resolves.toEqual({
      status: "completed",
    });

    expect(run).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000009",
      status: "completed",
    });
  });

  it("uses a durable delivery receipt when the worker died before outcome persistence", async () => {
    const dispatch = await createDispatch("delivery-receipt-fence");
    await recordTurnSummary({
      actor: dispatch.actor,
      conversationId: getDispatchConversationId(dispatch),
      destination: dispatch.destination,
      destinationVisibility: dispatch.destinationVisibility,
      dispatchId: dispatch.id,
      resultMessageId: "1700000000.000012",
      turnId: getDispatchTurnId(dispatch.id),
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
