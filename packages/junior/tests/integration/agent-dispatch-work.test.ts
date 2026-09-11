import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchRecord,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getUserMessageInstructionText } from "@/chat/pi/transcript";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { createModelStream } from "../fixtures/model-stream";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import {
  agentDispatchTestDestination as destination,
  createAgentDispatchTestRecord as createDispatch,
  createAgentDispatchWorkHarness,
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
    const { queue, run, state } = await createAgentDispatchWorkHarness(
      createModelAgentRunner(modelStream),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

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
  });

  it("runs enqueued dispatch work through production routing with exact authority", async () => {
    const dispatch = await createDispatch(
      "shared-runtime",
      undefined,
      undefined,
      { label: "Scheduled automation", detail: "Weekly" },
    );
    const agentRunner = createModelAgentRunner(
      createModelStream([{ type: "text", text: "Scheduled digest" }]),
    );
    const run = vi.spyOn(agentRunner, "run");
    const {
      queue,
      run: runWork,
      state,
    } = await createAgentDispatchWorkHarness(agentRunner);

    await enqueueAgentDispatch(dispatch, { queue, state });
    const queueMessage = queue.takeMessage();
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
    });
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
    });

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
  });

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
    const { queue, run, state } = await createAgentDispatchWorkHarness(
      createModelAgentRunner(
        createModelStream([{ type: "text", text: "Scheduled digest" }]),
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
    const { queue, run, state } = await createAgentDispatchWorkHarness(
      createModelAgentRunner(
        createModelStream([{ type: "text", text: "Work complete" }]),
      ),
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

  it("completes work with no outcomes without posting the model result", async () => {
    const dispatch = await createDispatch(
      "no-outcomes",
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
          name: "reportProgress",
          arguments: {
            message: "Applying the maintenance",
            intentAcknowledgment: true,
          },
        },
        { type: "text", text: "Maintenance complete" },
      ]),
    );
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, state } =
      await createAgentDispatchWorkHarness(agentRunner);

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(slackApiOutbox.messages()).toEqual([]);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "completed",
      outcomes: [],
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty("delivery");
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
    const { queue, run, state } = await createAgentDispatchWorkHarness(
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
