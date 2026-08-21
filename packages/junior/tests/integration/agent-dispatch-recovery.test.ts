import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  getDispatchConversationId,
  getDispatchRecord,
  getDispatchTurnId,
  listPendingDispatchMailboxAppends,
} from "@/chat/agent-dispatch/store";
import { recoverPendingDispatchMailboxAppends } from "@/chat/agent-dispatch/heartbeat";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import {
  createAgentDispatchTestRecord as createDispatch,
  createAgentDispatchWorkHarness,
} from "../fixtures/agent-dispatch";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("agent dispatch recovery", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("projects the diagnostic from a terminal model failure", async () => {
    const dispatch = await createDispatch("model-failure-detail");
    const firstRun = await createAgentDispatchWorkHarness(
      createModelAgentRunner(
        createModelStream([
          {
            type: "error",
            errorMessage: "Model provider quota exhausted",
          },
        ]),
      ),
    );
    await expect(
      firstRun.runtime.runDispatchTurn(dispatch, {
        ack: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({
      errorMessage: "Model provider quota exhausted",
      outcome: "failed",
      resultMessageTs: expect.any(String),
    });
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      getTurnRecord(
        getDispatchConversationId(dispatch),
        getDispatchTurnId(dispatch.id),
      ),
    ).resolves.toMatchObject({
      dispatchOutcome: "failed",
      errorMessage: "Model provider quota exhausted",
    });

    const replay = await createAgentDispatchWorkHarness(neverRunAgentRunner());
    await enqueueAgentDispatch(dispatch, {
      queue: replay.queue,
      state: replay.state,
    });
    await processConversationQueueMessage(replay.queue.takeMessage(), {
      queue: replay.queue,
      run: replay.run,
      state: replay.state,
    });

    expect(replay.queue.hasQueuedMessages()).toBe(false);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      errorMessage: "Model provider quota exhausted",
      resultMessageTs: expect.any(String),
      status: "failed",
    });
  });

  it("resumes paused dispatch work through production routing", async () => {
    const dispatch = await createDispatch(
      "resume",
      {
        type: "user",
        userId: "U123",
        allowedWhen: "scheduled-task",
        taskId: "task-123",
        binding: {
          type: "scheduled-task",
          plugin: "scheduler",
          taskId: "task-123",
          signature: "v1=test",
        },
      },
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "private",
      }),
      { label: "Scheduled task", detail: "Weekly" },
    );
    const agentRunner = createModelAgentRunner(
      createModelStream([
        { type: "toolCall", name: "systemTime", arguments: {} },
        { type: "text", text: "Resumed scheduled digest" },
      ]),
    );
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, state } =
      await createAgentDispatchWorkHarness(agentRunner);

    await enqueueAgentDispatch(dispatch, { queue, state });
    let deliveries = 0;
    while (queue.hasQueuedMessages()) {
      deliveries += 1;
      if (deliveries > 5) {
        throw new Error("Dispatch continuation queue did not drain");
      }
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        // Pause the first slice after the tool result is saved.
        softYieldAfterMs: deliveries === 1 ? 0 : undefined,
        state,
      });
    }

    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      text: "Resumed scheduled digest\n\nScheduled task · Weekly",
    });
    await expect(
      getTurnRecord(`agent-dispatch:${dispatch.id}`, `dispatch:${dispatch.id}`),
    ).resolves.toMatchObject({
      dispatchOutcome: "completed",
      resultMessageId: expect.any(String),
      state: "completed",
    });
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: expect.any(String),
      status: "completed",
    });
    expect(runAgent).toHaveBeenCalledTimes(2);
    const resumedRun = runAgent.mock.calls[1]?.[0];
    expect(resumedRun).toMatchObject({
      actor: dispatch.actor,
      credentialContext: {
        actor: dispatch.actor,
        subject: dispatch.credentialSubject,
      },
      dispatch: {
        id: dispatch.id,
        plugin: dispatch.plugin,
        replyAttribution: dispatch.replyAttribution,
      },
      source: dispatch.source,
      surface: "api",
    });
    expect(resumedRun?.instruction.text).toBe(dispatch.input);
    expect(resumedRun?.instruction.context).toBeUndefined();
  });

  it("repairs a pending mailbox append without owning execution recovery", async () => {
    const dispatch = await createDispatch("mailbox-append-repair");
    const queue = createConversationWorkQueueTestAdapter();
    const nowMs = Date.now();
    await expect(listPendingDispatchMailboxAppends()).resolves.toContain(
      dispatch.id,
    );

    await recoverPendingDispatchMailboxAppends({
      conversationWorkQueue: queue,
      nowMs,
    });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: `agent-dispatch:${dispatch.id}`,
        idempotencyKey: `agent-dispatch:${dispatch.id}`,
      },
    ]);
    await expect(listPendingDispatchMailboxAppends()).resolves.not.toContain(
      dispatch.id,
    );
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "pending",
    });
  });
});
