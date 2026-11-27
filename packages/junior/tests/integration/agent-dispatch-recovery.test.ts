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
import { getChatConfig } from "@/chat/config";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS } from "@/config/function-duration";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
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
  process.env["JUNIOR_STATE_ADAPTER"] = "memory";
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

  it("projects a failed turn's diagnostic and runs a turn again after a thrown error", async () => {
    const dispatch = await createDispatch("model-failure-detail");
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "error",
          errorMessage: "Model provider quota exhausted",
        },
        {
          type: "toolCall",
          name: "reply",
          arguments: { text: "Recovered digest" },
        },
      ]),
    );
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, runtime, state } =
      await createConversationWorkHarness(agentRunner);
    await expect(
      runtime.runDispatchTurn(dispatch, {
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

    // A paused run whose resume fails ends the dispatch on that delivery.
    const unresumable = await createDispatch("resume-failure");
    await saveTurnCheckpoint({
      conversationId: getDispatchConversationId(unresumable),
      dispatchId: unresumable.id,
      messages: [
        {
          role: "user",
          content: unresumable.input,
          timestamp: unresumable.createdAtMs,
        },
      ],
      mode: "paused",
      reason: "yield",
      sliceId: 1,
      turnId: getDispatchTurnId(unresumable.id),
    });
    // A thrown runtime error fails the turn without a dispatch outcome, so
    // the next delivery runs it again.
    const interrupted = await createDispatch("thrown-error");
    runAgent.mockRejectedValueOnce(new Error("Sandbox setup failed"));

    for (const replayed of [dispatch, unresumable, interrupted]) {
      await enqueueAgentDispatch(replayed, { queue, state });
    }
    let deliveries = 0;
    while (queue.hasQueuedMessages()) {
      deliveries += 1;
      if (deliveries > 6) {
        throw new Error("Dispatch queue did not drain");
      }
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        state,
      });
    }

    expect(deliveries).toBe(4);
    expect(runAgent).toHaveBeenCalledTimes(3);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      errorMessage: "Model provider quota exhausted",
      status: "failed",
    });
    await expect(getDispatchRecord(unresumable.id)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(getDispatchRecord(interrupted.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("resumes dispatch work after a timeout and ends it at its reply", async () => {
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
        { type: "toolCall", name: "systemTime", arguments: {} },
        // The host deadline aborts this request, so the Turn pauses.
        { type: "text", text: "Timed out", waitFor: "abort" },
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

    const requestBudgetMs =
      (getChatConfig().functionMaxDurationSeconds -
        FUNCTION_TIMEOUT_BUFFER_SECONDS) *
      1000;

    await enqueueAgentDispatch(dispatch, { queue, state });
    let deliveries = 0;
    while (queue.hasQueuedMessages()) {
      deliveries += 1;
      if (deliveries > 5) {
        throw new Error("Dispatch continuation queue did not drain");
      }
      await runWithTurnRequestDeadline(
        async () =>
          await processConversationQueueMessage(queue.takeMessage(), {
            queue,
            run,
            // In the resumed slice, a yield is due after the `reply` result.
            // No step follows it, so the Turn ends instead.
            softYieldAfterMs: deliveries === 2 ? 0 : undefined,
            state,
          }),
        // The first slice gets only 2.5s of the host request.
        deliveries === 1 ? Date.now() - requestBudgetMs + 2_500 : Date.now(),
      );
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
    expect(deliveries).toBe(2);
    expect(runAgent).toHaveBeenCalledTimes(2);
    // The resumed Run keeps the dispatch authority and thread.
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
    expect(resumedRun?.instruction.text).toBe(dispatch.input);
    expect(resumedRun?.instruction.context).toBeUndefined();
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
