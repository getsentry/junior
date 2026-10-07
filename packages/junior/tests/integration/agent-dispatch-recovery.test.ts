import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import {
  agentDispatchTestDestination as destination,
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
    });
    // A failed Automation run posts no internal error to its outcomes.
    expect(slackApiOutbox.messages()).toEqual([]);
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
      status: "failed",
    });
  });

  it("fails a stranded automation run without posting to its destination", async () => {
    const dispatch = await createDispatch("stranded-run");
    const { queue, state } = await createAgentDispatchWorkHarness(
      neverRunAgentRunner(),
    );
    // Automation Sources are not session Sources, so the fallback has no
    // Slack routing and posts nothing.
    await enqueueAgentDispatch(dispatch, { queue, state });
    const conversationId = getDispatchConversationId(dispatch);
    const turnId = getDispatchTurnId(dispatch.id);
    await upsertTurnRecord({
      conversationId,
      destination,
      dispatchId: dispatch.id,
      piMessages: [],
      sliceId: 1,
      source: dispatch.source,
      state: "running",
      surface: "api",
      turnId,
    });

    await runNextPausedTurn(conversationId, {
      agentRunner: neverRunAgentRunner(),
    });

    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      errorMessage: "Turn lost its worker before reaching a safe boundary",
      state: "failed",
    });
    expect(slackApiOutbox.messages()).toEqual([]);
  });

  it("resumes paused dispatch work through production routing", async () => {
    const dispatch = await createDispatch(
      "resume",
      {
        type: "user",
        userId: "U123",
        allowedWhen: "scheduled-automation",
        taskId: "task-123",
        binding: {
          type: "scheduled-automation",
          plugin: "scheduler",
          taskId: "task-123",
          signature: "v1=test",
        },
      },
      { kind: "scheduled_automation" },
      { label: "Scheduled automation", detail: "Weekly" },
      "Post the scheduled digest.",
      [
        {
          action: "send_message",
          destination: { ...destination, threadTs: "1700000000.000300" },
        },
      ],
      { ...destination, threadTs: "1700000000.000300" },
    );
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "toolCall",
          name: "finishAutomationRun",
          arguments: {
            result: "send_message",
            message: "Resumed scheduled digest",
          },
        },
        // The declared result is final. The resumed slice must not call the
        // model again and replace it.
        {
          type: "toolCall",
          name: "finishAutomationRun",
          arguments: {
            result: "send_message",
            message: "Replaced scheduled digest",
          },
        },
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
        // Pause the first slice after the declared result is saved.
        softYieldAfterMs: deliveries === 1 ? 0 : undefined,
        state,
      });
    }

    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      text: "Resumed scheduled digest\n\nScheduled automation · Weekly",
      thread_ts: "1700000000.000300",
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
      location: { threadTs: "1700000000.000300" },
      source: { kind: "scheduled_automation" },
      surface: "api",
    });
    expect(resumedRun).not.toHaveProperty("delivery");
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
