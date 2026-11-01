import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchRecord,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { LOST_WORKER_RESUME_MESSAGE } from "@/chat/task-execution/paused-turn";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getUserMessageInstructionText } from "@/chat/pi/transcript";
import { getConversationStore } from "@/chat/db";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { createModelStream } from "../fixtures/model-stream";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import {
  mockTitleModel,
  type TitleModelRequest,
} from "../fixtures/title-model";
import {
  agentDispatchTestDestination as destination,
  createAgentDispatchTestRecord as createDispatch,
  createConversationWorkHarness,
} from "../fixtures/agent-dispatch";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

/** Model output that ends an Automation run with a declared message. */
function sendMessage(message: string) {
  return {
    type: "toolCall" as const,
    name: "finishAutomationRun",
    arguments: { result: "send_message", message },
  };
}

describe("agent dispatch conversation work", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
    // Every run generates a Conversation title.
    mockTitleModel("Scheduled digest run");
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
    const modelStream = vi.fn(createModelStream([sendMessage("Done")]));
    const { queue, run, state } = await createConversationWorkHarness(
      createModelAgentRunner(modelStream),
    );

    // The title model returns no title, so run title generation fails.
    mockTitleModel("");
    await enqueueAgentDispatch(dispatch, { queue, state });
    const titleWork: Promise<unknown>[] = [];
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
      waitUntil: (work) => titleWork.push(work),
    });
    await Promise.all(titleWork);

    // A failed run title stays unset, so the dashboard keeps its fallback label.
    const untitled = await getConversationStore().get({
      conversationId: getDispatchConversationId(dispatch),
    });
    expect(untitled?.title).toBeUndefined();
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ text: "Done" }),
      }),
    ]);
    await expect(
      state.get(
        turnCursorKey(
          getDispatchConversationId(dispatch),
          getDispatchTurnId(dispatch.id),
        ),
      ),
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      publishExternally: true,
    });
    expect(modelStream).toHaveBeenCalledOnce();
    const instruction = modelStream.mock.calls[0]?.[1].messages.at(-1);
    if (!instruction) {
      throw new Error("Expected one model instruction");
    }
    expect(getUserMessageInstructionText(instruction)).toMatchInlineSnapshot(`
      "Post snake_case as written.
      - Keep this bullet."
    `);
  }, 15_000);

  it("runs enqueued dispatch work through production routing with exact authority", async () => {
    const store = getConversationStore();
    // A live Slack event saw the channel as private after the Automation saved
    // its public visibility.
    await store.recordActivity({
      conversationId: "slack:C123:1700000000.000300",
      destination,
      source: "slack",
      visibility: "private",
    });
    const { record: dispatch } = await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination,
        destinationVisibility: "public",
        idempotencyKey: "shared-runtime",
        input: "Post the scheduled digest.",
        replyAttribution: { label: "Scheduled automation", detail: "Weekly" },
        source: { kind: "scheduled_automation" },
      },
      plugin: "scheduler",
    });
    const agentRunner = createModelAgentRunner(
      createModelStream([sendMessage("Scheduled digest")]),
    );
    const run = vi.spyOn(agentRunner, "run");
    const {
      queue,
      run: runWork,
      state,
    } = await createConversationWorkHarness(agentRunner);

    const titleRequests: TitleModelRequest[] = [];
    mockTitleModel("Weekly digest for the platform team", {
      onRequest: (request) => titleRequests.push(request),
    });
    const conversationId = getDispatchConversationId(dispatch);
    const titleWork: Promise<unknown>[] = [];
    const waitUntil = (work: Promise<unknown>) => titleWork.push(work);

    await enqueueAgentDispatch(dispatch, { queue, state });
    const queueMessage = queue.takeMessage();
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
      waitUntil,
    });
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
      waitUntil,
    });
    await Promise.all(titleWork);

    // The run input is the title source because no human message exists.
    const titled = await store.get({ conversationId });
    expect(titled?.title).toBe("Weekly digest for the platform team");
    expect(JSON.stringify(titleRequests[0]?.messages)).toContain(
      "Task input: Post the scheduled digest.",
    );
    expect(queue.hasQueuedMessages()).toBe(false);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: destination.channelId,
      text: "Scheduled digest\n\nScheduled automation · Weekly",
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
      dispatch: {
        id: dispatch.id,
        plugin: "scheduler",
        replyAttribution: {
          label: "Scheduled automation",
          detail: "Weekly",
        },
      },
      source: { kind: "scheduled_automation" },
      surface: "api",
      disabledFeatures: ["interactive-auth"],
    });
    // Only live provider signals refresh the visibility that the channel's
    // Conversations share.
    await expect(
      store.getDestinationVisibility({
        provider: "slack",
        providerDestinationId: destination.channelId,
        providerTenantId: destination.teamId,
      }),
    ).resolves.toBe("private");
  }, 15_000);

  it("binds the default same-channel outcome reply to the dispatch's origin thread", async () => {
    const dispatch = await createDispatch(
      "outcome-thread-binding",
      undefined,
      { kind: "scheduled_automation" },
      undefined,
      "Post the scheduled digest.",
      [
        {
          action: "send_message",
          destination: { ...destination, threadTs: "1700000000.000200" },
        },
      ],
      { ...destination, threadTs: "1700000000.000200" },
    );
    const { queue, run, state } = await createConversationWorkHarness(
      createModelAgentRunner(
        createModelStream([sendMessage("Scheduled digest")]),
      ),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: destination.channelId,
      thread_ts: "1700000000.000200",
    });
  });

  it("sends successful work to each outcome destination in order", async () => {
    const dispatch = await createDispatch(
      "multiple-message-outcomes",
      undefined,
      undefined,
      undefined,
      "Send the result to both destinations.",
      [
        {
          action: "send_message",
          destination: { ...destination, channelId: "D123" },
        },
        {
          action: "send_message",
          destination: { ...destination, channelId: "C456" },
        },
      ],
    );
    const { queue, run, state } = await createConversationWorkHarness(
      createModelAgentRunner(createModelStream([sendMessage("Work complete")])),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(
      slackApiOutbox.messages().map((message) => message.params.channel),
    ).toEqual(["D123", "C456"]);
  });

  it("posts nothing for work with no outcomes, also when the run fails", async () => {
    const dispatch = await createDispatch(
      "no-outcomes",
      undefined,
      undefined,
      undefined,
      "Apply the requested maintenance.",
      [],
    );
    const lostDispatch = await createDispatch(
      "no-outcomes-lost-worker",
      undefined,
      undefined,
      undefined,
      "Apply the requested maintenance.",
      [],
    );
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "toolCall",
          name: "finishAutomationRun",
          arguments: { result: "no_action", reason: "Maintenance complete" },
        },
        { type: "toolCall", name: "systemTime", arguments: {} },
      ]),
    );
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, state } =
      await createConversationWorkHarness(agentRunner);
    const processNext = async (softYieldAfterMs?: number) =>
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        softYieldAfterMs,
        state,
      });

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processNext();

    expect(slackApiOutbox.messages()).toEqual([]);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "completed",
      outcomes: [],
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty("delivery");

    // The second run pauses, and its resumed worker dies before it saves.
    // Recovery fails the run, and the failure still posts nothing.
    await enqueueAgentDispatch(lostDispatch, { queue, state });
    await processNext(0);
    const conversationId = getDispatchConversationId(lostDispatch);
    const turnId = getDispatchTurnId(lostDispatch.id);
    const paused = await getTurnRecord(conversationId, turnId);
    if (paused?.state !== "paused") throw new Error("expected paused turn");
    await saveTurnCheckpoint({
      conversationId,
      errorMessage: LOST_WORKER_RESUME_MESSAGE,
      lostWorkerResumeCount: 1,
      messages: paused.piMessages,
      mode: "paused",
      reason: "retry",
      sliceId: paused.sliceId,
      turnId,
    });
    await processNext();

    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "failed",
    });
    await expect(getDispatchRecord(lostDispatch.id)).resolves.toMatchObject({
      status: "failed",
    });
    expect(slackApiOutbox.messages()).toEqual([]);
  });

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
    const { queue, run, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(queue.hasQueuedMessages()).toBe(false);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000009",
      status: "completed",
    });
  });
});
