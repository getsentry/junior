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
import { CONVERSATION_WORK_MAX_RETRIES } from "@/chat/task-execution/store";
import {
  createConversationWorkHarness,
  createConversationWorkQueueTestAdapter,
  runHeartbeatAfterLeasesExpire,
} from "../fixtures/conversation-work";
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
  agentDispatchTestDestination as destination,
  createAgentDispatchTestRecord as createDispatch,
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
    vi.useRealTimers();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("projects the diagnostic from a terminal model failure", async () => {
    const dispatch = await createDispatch("model-failure-detail");
    const firstRun = await createConversationWorkHarness(
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

    const replay = await createConversationWorkHarness(neverRunAgentRunner());
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

  it("ends dispatch work at its reply when a yield is due", async () => {
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
          name: "reply",
          arguments: { text: "Resumed scheduled digest" },
        },
        // The reply is final. The model must not be called again to replace
        // it.
        {
          type: "toolCall",
          name: "reply",
          arguments: { text: "Replaced scheduled digest" },
        },
      ]),
    );
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, state } =
      await createConversationWorkHarness(agentRunner);

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
        // A yield is due after the `reply` result. No step follows it, so the
        // Turn ends instead.
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
    expect(deliveries).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const dispatchRun = runAgent.mock.calls[0]?.[0];
    expect(dispatchRun).toMatchObject({
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
    expect(dispatchRun?.instruction.text).toBe(dispatch.input);
    expect(dispatchRun?.instruction.context).toBeUndefined();
  });

  it("fails the dispatch when every try of its worker is killed", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const dispatch = await createDispatch("killed-worker");
    const { killWorker, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
      // Injected fault: the worker of this try is killed mid-run.
      await killWorker(
        queue.takeMessageFor(getDispatchConversationId(dispatch)),
      );
      await runHeartbeatAfterLeasesExpire(queue);
    }

    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      errorMessage: "Dispatch work stopped after repeated failed attempts.",
      status: "failed",
    });
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
