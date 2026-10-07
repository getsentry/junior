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

/** Model output that ends an Automation run with one declared result. */
function finishRun(
  args:
    | { result: "send_message"; message: string }
    | { result: "no_action" | "misconfigured"; reason: string },
) {
  return {
    type: "toolCall" as const,
    name: "finishAutomationRun",
    arguments: args,
  };
}

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
      createModelStream([
        finishRun({ result: "send_message", message: "Done" }),
      ]),
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
      createModelStream([
        finishRun({ result: "send_message", message: "Scheduled digest" }),
      ]),
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

  it("sends the declared message to each outcome destination in order", async () => {
    const originThread = { ...destination, threadTs: "1700000000.000200" };
    const dispatch = await createDispatch(
      "message-outcomes",
      undefined,
      undefined,
      undefined,
      "Post the scheduled digest.",
      [
        { action: "send_message", destination: originThread },
        {
          action: "send_message",
          destination: { ...destination, channelId: "D123" },
        },
      ],
      originThread,
    );
    const { queue, run, state } = await createAgentDispatchWorkHarness(
      createModelAgentRunner(
        createModelStream([
          finishRun({ result: "send_message", message: "Scheduled digest" }),
        ]),
      ),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(
      slackApiOutbox.messages().map(({ params }) => ({
        channel: params.channel,
        thread_ts: params.thread_ts,
      })),
    ).toEqual([
      { channel: destination.channelId, thread_ts: "1700000000.000200" },
      { channel: "D123", thread_ts: undefined },
    ]);
  });

  it.each([
    {
      second: finishRun({
        result: "send_message",
        message: "Scheduled digest",
      }),
      expected: { posted: ["Scheduled digest"], status: "completed" },
    },
    {
      second: { type: "text" as const, text: "Second draft" },
      // The failure shows on the Automation, not in its outcomes.
      expected: { posted: [], status: "failed" },
    },
  ])(
    "reminds once when the run stops without a result ($expected.status)",
    async ({ second, expected }) => {
      const dispatch = await createDispatch(
        `missing-result-${expected.status}`,
      );
      const { queue, run, state } = await createAgentDispatchWorkHarness(
        createModelAgentRunner(
          createModelStream([{ type: "text", text: "First draft" }, second]),
        ),
      );

      await enqueueAgentDispatch(dispatch, { queue, state });
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        state,
      });

      expect(
        slackApiOutbox.messages().map(({ params }) => params.text),
      ).toEqual(expected.posted);
      await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
        status: expected.status,
      });
    },
  );

  it.each([
    {
      name: "no_action",
      declared: finishRun({ result: "no_action", reason: "Maintenance done" }),
      outcomes: [],
      expected: { outcomes: [], status: "completed" },
    },
    {
      name: "misconfigured",
      declared: finishRun({
        result: "misconfigured",
        reason: "The maintenance repo was archived.",
      }),
      outcomes: [],
      expected: {
        errorMessage: "The maintenance repo was archived.",
        outcomes: [],
        status: "blocked",
      },
    },
    {
      // Instructions written before declared results still ask for the
      // no-reply marker. A message outcome must not post it.
      name: "no-reply marker",
      declared: finishRun({ result: "send_message", message: "[[NO_REPLY]]" }),
      outcomes: undefined,
      expected: { status: "completed" },
    },
  ])(
    "records a declared $name result without posting",
    async ({ name, declared, outcomes, expected }) => {
      const dispatch = await createDispatch(
        `silent-${name}`,
        undefined,
        undefined,
        undefined,
        "Apply the requested maintenance.",
        outcomes,
      );
      const agentRunner = createModelAgentRunner(createModelStream([declared]));
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
      await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject(
        expected,
      );
      expect(runAgent).toHaveBeenCalledOnce();
      expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty("delivery");
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
