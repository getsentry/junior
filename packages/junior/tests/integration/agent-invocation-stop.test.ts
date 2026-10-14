import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import {
  enqueueAgentInvocationResult,
  startAgentInvocationsForChildResults,
} from "@/chat/agent-invocations/result";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationIdForResult,
  getAgentInvocationTurnId,
  listPendingAgentInvocationMailboxAppends,
} from "@/chat/agent-invocations/store";
import type {
  CreateAgentInvocationInput,
  TerminalAgentInvocation,
} from "@/chat/agent-invocations/types";
import {
  createAgentInvocationWorker,
  createAndEnqueueAgentInvocation,
  routeAgentInvocationWork,
} from "@/chat/agent-invocations/work";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
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
  createConversationWorkQueueTestAdapter,
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
  return (await createListAgentsTool(parentConversationId).execute!({}, {}))
    .agents;
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

async function createHarness() {
  const { conversationStore, fixture } = await prepareParentConversation();
  const state = getStateAdapter();
  await state.connect();
  const queue = createConversationWorkQueueTestAdapter();
  const mailbox = async (conversationId: string) =>
    (await getConversationWorkState({ conversationId, state }))?.messages ?? [];
  return {
    close: async () => await fixture.close(),
    /** Build the worker context for the child's queued input. */
    async context(
      conversationId: string,
      signal?: AbortSignal,
    ): Promise<ConversationWorkerContext> {
      const messages = await mailbox(conversationId);
      return {
        attempt: {
          ack: async () => undefined,
          conversationId,
          drain: async () => [],
          isFinalAttempt: false,
          messages,
        },
        checkIn: async () => true,
        conversationId,
        shouldYield: () => false,
        ...(signal ? { stopSignal: () => signal } : undefined),
      };
    },
    mailbox,
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
    worker: (agentRunner: AgentRunner) =>
      createAgentInvocationWorker(agentRunner, {
        enqueueResult: async (invocation) =>
          await enqueueAgentInvocationResult(invocation, { queue, state }),
      }),
  };
}

describe("stopping child agents", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stops a running child without a result and lets its name take new work", async () => {
    const harness = await createHarness();
    try {
      const running = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "stop-running",
        input: "long task",
      });
      const started = deferred<void>();
      // Stands in for the worker's poll of the Conversation stop request.
      const stopRequest = new AbortController();
      const processing = harness.worker({
        run: async (run) => {
          started.resolve(undefined);
          return await waitForAbort(run);
        },
      })(
        await harness.context(running.childConversationId, stopRequest.signal),
        running.invocationId,
      );
      await started.promise;

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
      stopRequest.abort(new Error("Conversation work stopped"));
      await expect(processing).resolves.toEqual({ status: "completed" });

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
      // The stop frees the busy name.
      await expect(
        harness.spawn({
          agentName: "researcher",
          idempotencyKey: "after-stop",
          input: "short task",
        }),
      ).resolves.toMatchObject({
        childConversationId: running.childConversationId,
        status: "pending",
      });
    } finally {
      await harness.close();
    }
  });

  it("never runs a stopped pending child and reports other stops to the parent", async () => {
    const harness = await createHarness();
    const neverRun: AgentRunner = {
      run: async () => {
        throw new Error("A stopped child must not run");
      },
    };
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
      await expect(
        harness.worker(neverRun)(
          await harness.context(pending.childConversationId),
          pending.invocationId,
        ),
      ).resolves.toEqual({ status: "completed" });
      await expect(
        getAgentInvocation(pending.invocationId),
      ).resolves.toMatchObject({ status: "stopped" });

      // A stop request can outlive its run. The stopped agent invocation
      // handles the next empty wake.
      const invocationWorker = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const wake = await harness.context(pending.childConversationId);
      await routeAgentInvocationWork({
        fallbackWorker: async () => {
          throw new Error("Child work reached the fallback worker");
        },
        invocationWorker,
      })({ ...wake, attempt: { ...wake.attempt, messages: [] } });
      expect(invocationWorker).toHaveBeenCalledWith(
        expect.anything(),
        pending.invocationId,
      );

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
      const stopRequest = new AbortController();
      stopRequest.abort(new Error("Conversation work stopped"));
      await expect(
        harness.worker({ run: waitForAbort })(
          await harness.context(
            external.childConversationId,
            stopRequest.signal,
          ),
          external.invocationId,
        ),
      ).resolves.toEqual({ status: "completed" });
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
    const harness = await createHarness();
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
      const childContext = await harness.context(child.childConversationId);
      expect(childContext.attempt.messages).toHaveLength(1);
      await expect(
        startAgentInvocationsForChildResults(childContext, {
          queue: harness.queue,
          state: harness.state,
        }),
      ).resolves.toEqual({ status: "completed" });
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
