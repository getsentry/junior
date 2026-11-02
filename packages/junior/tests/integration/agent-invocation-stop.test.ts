import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { enqueueAgentInvocationResult } from "@/chat/agent-invocations/result";
import {
  completeAgentInvocation,
  createAgentInvocation,
  createAgentInvocationForMessage,
  getAgentInvocation,
  getAgentInvocationIdForResult,
  getAgentInvocationTurnId,
  listPendingAgentInvocationMailboxAppends,
} from "@/chat/agent-invocations/store";
import type {
  CreateAgentInvocationInput,
  TerminalAgentInvocation,
} from "@/chat/agent-invocations/types";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { stopConversationTurn } from "@/chat/conversations/stop";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  invocationInput,
  loadSubagentEvents,
  loadTurnEvents,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import {
  createConversationWorkHarness,
  deferred,
} from "../fixtures/conversation-work";

async function stopAgent(
  conversationId: string,
  parent = parentConversationId,
) {
  return await createStopAgentTool(parent).execute!(
    { conversation_id: conversationId },
    {},
  );
}

async function listAgents() {
  return (
    await createListAgentsTool({ conversationId: parentConversationId })
      .execute!({}, {})
  ).agents;
}

/** Wait until the run is aborted, then fail like an aborted agent run. */
async function waitForAbort(run: AgentRun): Promise<never> {
  const signal = run.signal;
  if (!signal) {
    throw new Error("Child run has no stop signal");
  }
  if (!signal.aborted) {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  }
  throw signal.reason;
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

/** Run each child until a stop aborts it, and report when it starts. */
function abortableAgentRunner() {
  let started = deferred<void>();
  const runs: AgentRun[] = [];
  return {
    agentRunner: {
      run: async (run: AgentRun) => {
        runs.push(run);
        started.resolve(undefined);
        return await waitForAbort(run);
      },
    } satisfies AgentRunner,
    runs,
    /** Wait for the next run to start. */
    started: async () => {
      await started.promise;
      started = deferred<void>();
    },
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
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
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
      await expect(listAgents()).resolves.toEqual([
        {
          conversation_id: running.childConversationId,
          error: "Stopped by the parent conversation",
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
      // A message from the parent starts new work on the stopped child.
      await expect(
        createAgentInvocationForMessage({
          ...invocationInput,
          childConversationId: running.childConversationId,
          idempotencyKey: "after-stop",
          input: "short task",
          parentToolCallId: "call-after-stop",
        }),
      ).resolves.toMatchObject({
        invocation: {
          agentName: "researcher",
          childConversationId: running.childConversationId,
          status: "pending",
        },
        queued: false,
      });
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

      // A stop that does not come from stopAgent still reaches the parent,
      // and it also stops the child agents of the child.
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
        stopConversationTurn({
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
      const doneResult = (await completeAgentInvocation({
        invocationId: doneHelper.invocationId,
        result: "Helper fact: 42.",
        status: "completed",
      })) as TerminalAgentInvocation;
      // The result reaches the child mailbox before the stop.
      await enqueueAgentInvocationResult(doneResult, {
        queue: harness.queue,
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
      ).rejects.toThrow("has no open work");
      await expect(
        getAgentInvocation(doneHelper.invocationId),
      ).resolves.toMatchObject({
        parentMailboxStatus: "skipped",
        status: "completed",
      });
      // The child already had the result in its mailbox. It starts no work.
      await expect(
        harness.mailbox(child.childConversationId),
      ).resolves.toHaveLength(1);
      await expect(
        harness.processNext(child.childConversationId),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        getAgentInvocation(
          getAgentInvocationIdForResult(doneHelper.invocationId),
        ),
      ).resolves.toBeUndefined();
      await expect(listAgents()).resolves.toEqual([
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
