import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeliverToParent,
  enqueueAgentInvocationResult,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import {
  getAgentInvocationIdForResult,
  getAgentInvocationTurnId,
  getAgentReplyMessageId,
  getTurnReplyKey,
} from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getAgentInvocation,
  listPendingAgentInvocationMailboxAppends,
} from "@/chat/agent-invocations/store";
import type {
  CreateAgentInvocationInput,
  TerminalAgentInvocation,
} from "@/chat/agent-invocations/types";
import {
  createAndEnqueueAgentInvocation,
  enqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { stopConversation } from "@/chat/conversations/stop";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  abortableAgentRunner,
  invocationInput,
  loadSubagentEvents,
  loadTurnEvents,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import { createConversationWorkHarness } from "../fixtures/conversation-work";

async function stopAgent(
  conversationId: string,
  parent = parentConversationId,
) {
  return await createStopAgentTool(parent).execute!(
    { conversation_id: conversationId },
    {},
  );
}

async function searchAgents() {
  return (
    await createSearchAgentsTool({ conversationId: parentConversationId })
      .execute!({}, {})
  ).agents;
}

/**
 * Compose production conversation work for a local parent. Each test runs
 * child work from the queue, as the queue callback does.
 */
async function createHarness(agentRunner: AgentRunner) {
  const { conversationStore, fixture } = await prepareParentConversation();
  const work = await createConversationWorkHarness(agentRunner);
  const { queue, state } = work;
  return {
    close: async () => await fixture.close(),
    conversationStore,
    mailbox: async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [],
    process: work.process,
    /** Run the next queued wake of one Conversation. */
    processNext: async (conversationId: string) =>
      await work.process(queue.takeMessageFor(conversationId)),
    queue,
    spawn: async (
      overrides: Partial<CreateAgentInvocationInput> & {
        idempotencyKey: string;
      },
    ) =>
      await createAndEnqueueAgentInvocation(
        { ...invocationInput, ...overrides },
        { conversationStore, queue, state },
      ),
    state,
  };
}

describe("stopping child agents", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stops a running child without a result and lets a message start new work", async () => {
    const runner = abortableAgentRunner();
    const harness = await createHarness(runner.agentRunner);
    try {
      const running = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "stop-running",
        input: "long task",
      });
      const processing = harness.processNext(running.childConversationId);
      await runner.started();
      // The child replies, and the parent has not read the reply at the stop.
      await enqueueChildResultToParent({
        queue: harness.queue,
        result: {
          kind: "reply",
          reply: { text: "Old finding.", toolCallId: "call-old-reply" },
        },
        messageKey: "call-old-reply",
        sender: running,
        state: harness.state,
      });

      await expect(stopAgent(running.childConversationId)).resolves.toEqual({
        conversation_id: running.childConversationId,
        stopped: true,
      });
      const work = await getConversationWorkState({
        conversationId: running.childConversationId,
        state: harness.state,
      });
      await expect(
        hasConversationStop({
          conversationId: running.childConversationId,
          runId: work!.execution.runId!,
          state: harness.state,
        }),
      ).resolves.toBe(true);
      // The worker sees the stop request and aborts the run.
      await expect(processing).resolves.toMatchObject({ status: "completed" });

      await expect(
        getAgentInvocation(running.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "Stopped by the parent conversation",
        parentMailboxStatus: "skipped",
        status: "stopped",
      });
      // The parent asked for the stop, so no result Turn wakes it.
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentReplyMessageId(
            running.invocationId,
            "call-old-reply",
          ),
        }),
      ]);
      await expect(
        loadTurnEvents(running.childConversationId),
      ).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            turnId: getAgentInvocationTurnId(running.invocationId),
            type: "turn_completed",
          }),
        }),
      );
      await expect(
        loadSubagentEvents(parentConversationId),
      ).resolves.toContainEqual(
        expect.objectContaining({
          outcome: "aborted",
          subagentInvocationId: running.invocationId,
          type: "subagent_ended",
        }),
      );
      await expect(searchAgents()).resolves.toEqual([
        {
          conversation_id: running.childConversationId,
          error: "Stopped by the parent conversation",
          kind: "task",
          name: "researcher",
          relation: "child",
          status: "stopped",
          task: "long task",
          updated_at: expect.any(String),
        },
      ]);
      // A repeated stop finds no open work.
      await expect(stopAgent(running.childConversationId)).resolves.toEqual({
        conversation_id: running.childConversationId,
        stopped: false,
      });
      // A message from the parent starts new work on the stopped child, in
      // the same parent Turn as the stop.
      const retask = await createAgentInvocationForMessage(
        {
          ...invocationInput,
          childConversationId: running.childConversationId,
          idempotencyKey: "after-stop",
          input: "short task",
          parentToolCallId: "call-after-stop",
        },
        Date.now() + 1,
      );
      await enqueueAgentInvocation(retask.invocation, {
        queue: harness.queue,
        state: harness.state,
      });
      expect(retask).toMatchObject({
        invocation: {
          agentName: "researcher",
          childConversationId: running.childConversationId,
          status: "pending",
        },
        queued: false,
      });
      await expect(
        getConversationStoppedAtMs(running.childConversationId),
      ).resolves.toBeUndefined();
      // The new task does not bring back the stopped work's reply.
      await expect(
        harness.processNext(parentConversationId),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      expect(runner.runs).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // A reply from a Turn on the child's Conversation loop names the child's
  // finished spawn, which the stop does not mark, so the stop drops the reply
  // from the parent's mailbox.
  it("drops an unread reply from a child's Conversation loop Turn when the parent stops it", async () => {
    const runner = abortableAgentRunner();
    const harness = await createHarness(runner.agentRunner);
    try {
      const child = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "stop-loop-reply",
        input: "watch deploys",
      });
      await completeAgentInvocation({
        invocationId: child.invocationId,
        result: "Watching.",
        status: "completed",
      });
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: child.childConversationId,
        result: {
          kind: "reply",
          reply: { text: "Old finding.", toolCallId: "call-old-reply" },
        },
        turnId: "turn_watch-event",
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentReplyMessageId(
            child.invocationId,
            getTurnReplyKey("turn_watch-event", "call-old-reply"),
          ),
        }),
      ]);

      const beforeStopMs = Date.now();
      await stopAgent(child.childConversationId);
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      // A reply that the Turn sent before the stop reaches the parent's
      // mailbox after the stop dropped the unread ones.
      const sendLateReply = async () =>
        await enqueueChildResultToParent({
          actor: EVENT_SYSTEM_ACTOR,
          messageKey: getTurnReplyKey("turn_watch-event", "call-late-reply"),
          nowMs: beforeStopMs,
          queue: harness.queue,
          result: {
            kind: "reply",
            reply: { text: "Late finding.", toolCallId: "call-late-reply" },
          },
          sender: child,
          state: harness.state,
        });
      await sendLateReply();
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      // The parent gives the child a new task in the same Turn.
      const retask = await createAgentInvocationForMessage(
        {
          ...invocationInput,
          childConversationId: child.childConversationId,
          idempotencyKey: "after-loop-stop",
          input: "short task",
          parentToolCallId: "call-after-loop-stop",
        },
        Date.now() + 1,
      );
      await enqueueAgentInvocation(retask.invocation, {
        queue: harness.queue,
        state: harness.state,
      });
      await expect(
        getConversationStoppedAtMs(child.childConversationId),
      ).resolves.toBeUndefined();
      // The stopped Turn's retry sends the dropped reply again.
      await sendLateReply();
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      expect(runner.runs).toHaveLength(0);

      // A person's stop of a child drops its unread reply too.
      const watcher = await harness.spawn({
        agentName: "builder",
        idempotencyKey: "person-stop-loop-reply",
        input: "watch builds",
      });
      await completeAgentInvocation({
        invocationId: watcher.invocationId,
        result: "Watching.",
        status: "completed",
      });
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: watcher.childConversationId,
        result: {
          kind: "reply",
          reply: { text: "Build finding.", toolCallId: "call-build-reply" },
        },
        turnId: "turn_build-event",
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toHaveLength(
        1,
      );
      await stopConversation({
        conversationId: watcher.childConversationId,
        conversationStore: harness.conversationStore,
        queue: harness.queue,
        state: harness.state,
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("ends a running child's Turn at its next step after a stored stop", async () => {
    const harness = await createHarness({
      run: async (run) => {
        // Only the stored stop is set. No stop request reaches the worker.
        await markConversationsStopped([run.conversationId!], {
          cancelWatches: false,
        });
        // The agent loop checks for a stop at each step boundary.
        await run.durability?.checkStop?.();
        run.signal?.throwIfAborted();
        throw new Error("The stored stop did not abort the run");
      },
    });
    try {
      const running = await harness.spawn({ idempotencyKey: "stored-stop" });

      await expect(
        harness.processNext(running.childConversationId),
      ).resolves.toMatchObject({ status: "completed" });

      await expect(
        getAgentInvocation(running.invocationId),
      ).resolves.toMatchObject({ status: "stopped" });
      await expect(
        loadTurnEvents(running.childConversationId),
      ).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            type: "turn_completed",
          }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("never runs a stopped pending child and reports other stops to the parent", async () => {
    const runner = abortableAgentRunner();
    const harness = await createHarness(runner.agentRunner);
    try {
      const pending = await harness.spawn({
        idempotencyKey: "stop-pending",
        input: "short task",
      });
      await expect(
        stopAgent(pending.childConversationId, "local:test:other-parent"),
      ).rejects.toMatchObject({ name: "ToolInputError" });
      await expect(stopAgent(pending.childConversationId)).resolves.toEqual({
        conversation_id: pending.childConversationId,
        stopped: true,
      });
      // The stopped child takes its wake without a run. A redelivery finds
      // no work.
      const wake = harness.queue.takeMessageFor(pending.childConversationId);
      await expect(harness.process(wake)).resolves.toMatchObject({
        status: "completed",
      });
      await expect(harness.process(wake)).resolves.toMatchObject({
        status: "no_work",
      });
      expect(runner.runs).toEqual([]);
      await expect(
        getAgentInvocation(pending.invocationId),
      ).resolves.toMatchObject({ status: "stopped" });

      // A person's stop of the child still reaches the parent, and it also
      // stops the child agents of the child.
      const external = await harness.spawn({
        idempotencyKey: "stop-external",
        input: "long task",
      });
      const helper = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "stop-external-helper",
        parentConversationId: external.childConversationId,
      });
      const processing = harness.processNext(external.childConversationId);
      await runner.started();
      await expect(
        stopConversation({
          conversationId: external.childConversationId,
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        }),
      ).resolves.toMatchObject({ status: "requested" });
      await expect(processing).resolves.toMatchObject({ status: "completed" });
      await expect(
        getAgentInvocation(external.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "Agent invocation was stopped",
        parentMailboxStatus: "appended",
        status: "stopped",
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            metadata: expect.objectContaining({
              event: expect.objectContaining({
                eventType: "agent_invocation.stopped",
              }),
            }),
          }),
        }),
      ]);
      await expect(
        getAgentInvocation(helper.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "skipped",
        status: "stopped",
      });
      // The helper was stopped before its mailbox append. The heartbeat must
      // not start it.
      expect(
        (await listPendingAgentInvocationMailboxAppends()).map(
          (invocation) => invocation.invocationId,
        ),
      ).not.toContain(helper.invocationId);
    } finally {
      await harness.close();
    }
  });

  it("stops every child agent below the child and drops their results", async () => {
    const harness = await createHarness(neverRunAgentRunner());
    try {
      const child = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "tree-child",
      });
      const openHelper = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "tree-open-helper",
        parentConversationId: child.childConversationId,
      });
      const doneHelper = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "tree-done-helper",
        parentConversationId: child.childConversationId,
      });
      // A completed helper sends nothing, so this one ends blocked.
      const doneResult = (await completeAgentInvocation({
        errorMessage: "Helper needs a token.",
        invocationId: doneHelper.invocationId,
        status: "blocked",
      })) as TerminalAgentInvocation;
      // The result and a `reply` reach the child mailbox before the stop.
      await enqueueAgentInvocationResult(doneResult, {
        queue: harness.queue,
        state: harness.state,
      });
      await enqueueChildResultToParent({
        queue: harness.queue,
        result: {
          kind: "reply",
          reply: { text: "Open helper finding.", toolCallId: "call-reply" },
        },
        messageKey: "call-reply",
        sender: openHelper,
        state: harness.state,
      });
      // The child finished its own turn while its helpers still work.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "Started helpers.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });

      await expect(stopAgent(child.childConversationId)).resolves.toEqual({
        conversation_id: child.childConversationId,
        stopped: true,
      });

      await expect(
        getAgentInvocation(openHelper.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "skipped",
        status: "stopped",
      });
      // A late spawnAgent call of the stopped child starts no work.
      await expect(
        createAgentInvocation({
          ...invocationInput,
          idempotencyKey: "tree-late-helper",
          parentConversationId: child.childConversationId,
        }),
      ).rejects.toThrow("is stopped and cannot give work");
      await expect(
        getAgentInvocation(doneHelper.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "skipped",
        status: "blocked",
      });
      // The child already had the result and the reply in its mailbox. They
      // start no work.
      await expect(
        harness.mailbox(child.childConversationId),
      ).resolves.toHaveLength(2);
      await expect(
        harness.processNext(child.childConversationId),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        getAgentInvocation(
          getAgentInvocationIdForResult(doneHelper.invocationId),
        ),
      ).resolves.toBeUndefined();
      await expect(searchAgents()).resolves.toEqual([
        expect.objectContaining({
          conversation_id: child.childConversationId,
          status: "stopped",
        }),
      ]);
    } finally {
      await harness.close();
    }
  });
});
