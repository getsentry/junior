import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentRun } from "@/chat/agent/types";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import {
  createAgentInvocationForMessage,
  getAgentInvocation,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/store";
import {
  createAgentInvocationWorker,
  enqueueAgentInvocation,
  routeAgentInvocationWork,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import type { CreateAgentInvocationInput } from "@/chat/agent-invocations/types";
import { startAgentInvocationsForChildInput } from "@/chat/agent-invocations/result";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { getAutomatedTurnLimitState } from "@/chat/services/automated-turn-limit";
import { createEventTools } from "@/chat/tools/events";
import { skipInputBeforeConversationStop } from "@/chat/conversations/session-stop";
import { context, execute } from "../fixtures/event-automations";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  createConversationWorkQueueTestAdapter,
  deferred,
} from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

const parentConversationId = "local:test:agent-invocation-concurrency";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const baseInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  input: "Do the delegated work.",
  parentConversationId,
};

async function listAgents() {
  return await createListAgentsTool(parentConversationId).execute!({}, {});
}

function taskModel(request: AgentRun): StreamFn {
  return createModelStream([
    { type: "text", text: `result:${request.instruction.text}` },
  ]);
}

async function createHarness(streamForRun: (request: AgentRun) => StreamFn) {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  const state = getStateAdapter();
  await state.connect();
  const queue = createConversationWorkQueueTestAdapter();
  const agentRunner = createModelAgentRunnerForRun(streamForRun);
  const run = vi.spyOn(agentRunner, "run");
  const route = routeAgentInvocationWork({
    // The same order as production conversation work.
    fallbackWorker: async (workContext) =>
      (await skipInputBeforeConversationStop(workContext)) ??
      (await startAgentInvocationsForChildInput(workContext, {
        queue,
        state,
      })) ?? { status: "completed" as const },
    invocationWorker: createAgentInvocationWorker(agentRunner),
  });

  return {
    async close() {
      await fixture.close();
    },
    async drainQueuedWork() {
      while (queue.hasQueuedMessages()) {
        const batch = queue.queuedMessages();
        await Promise.all(
          batch.map(async () => {
            await processConversationQueueMessage(queue.takeMessage(), {
              conversationStore,
              queue,
              run: route,
              state,
            });
          }),
        );
      }
    },
    processQueuedBatch: async () => {
      const batch = queue.queuedMessages();
      await Promise.all(
        batch.map(async () => {
          await processConversationQueueMessage(queue.takeMessage(), {
            conversationStore,
            queue,
            run: route,
            state,
          });
        }),
      );
    },
    /** Send one parent message to an existing child, as messageAgent does. */
    message: async (args: {
      childConversationId: string;
      idempotencyKey: string;
      input: string;
    }) => {
      const { invocation } = await createAgentInvocationForMessage({
        ...baseInput,
        ...args,
        parentToolCallId: args.idempotencyKey,
      });
      await enqueueAgentInvocation(invocation, {
        conversationStore,
        queue,
        state,
      });
      return invocation;
    },
    queue,
    requests: (): AgentRun[] => run.mock.calls.map(([request]) => request),
    spawn: async (
      overrides: Partial<CreateAgentInvocationInput> & {
        idempotencyKey: string;
      },
    ) =>
      await createAndEnqueueAgentInvocation(
        { ...baseInput, ...overrides },
        { conversationStore, queue, state },
      ),
  };
}

describe("agent invocation identity and concurrency", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("gives each unnamed invocation a fresh child without inherited history", async () => {
    const harness = await createHarness(taskModel);
    try {
      const first = await harness.spawn({
        idempotencyKey: "fresh-1",
        input: "first unnamed task",
      });
      await harness.drainQueuedWork();
      const second = await harness.spawn({
        idempotencyKey: "fresh-2",
        input: "second unnamed task",
      });
      await harness.drainQueuedWork();

      expect(second.childConversationId).not.toBe(first.childConversationId);
      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.history)).toEqual([[], []]);
      await expect(
        getAgentInvocation(first.invocationId),
      ).resolves.toMatchObject({
        result: "result:first unnamed task",
        status: "completed",
      });
      await expect(
        getAgentInvocation(second.invocationId),
      ).resolves.toMatchObject({
        result: "result:second unnamed task",
        status: "completed",
      });
    } finally {
      await harness.close();
    }
  });

  it("continues a named child with a message and supplies its completed history", async () => {
    const harness = await createHarness(taskModel);
    try {
      const first = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "named-1",
        input: "first named task",
        reasoningLevel: "high",
      });
      await harness.drainQueuedWork();
      const second = await harness.message({
        childConversationId: first.childConversationId,
        idempotencyKey: "named-2",
        input: "second named task",
      });
      await expect(listAgents()).resolves.toEqual({
        agents: [
          {
            conversation_id: first.childConversationId,
            last_result: "completed",
            name: "researcher",
            status: "pending",
            task: "second named task",
            updated_at: expect.any(String),
          },
        ],
      });
      await harness.drainQueuedWork();

      expect(second.childConversationId).toBe(first.childConversationId);
      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.history).toEqual([]);
      expect(requests[0]?.reasoning).toBe("high");
      expect(requests[0]?.disabledFeatures).toEqual([
        "handoff",
        "interactive-auth",
        "subagents",
      ]);
      // A message keeps the reasoning level of the child.
      expect(requests[1]?.reasoning).toBe("high");
      expect(requests[1]?.disabledFeatures).toEqual([
        "handoff",
        "interactive-auth",
        "subagents",
      ]);
      expect(requests[1]?.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );
      expect(JSON.stringify(requests[1]?.history)).toContain(
        "result:first named task",
      );
      await expect(
        getAgentInvocation(second.invocationId),
      ).resolves.toMatchObject({
        agentName: "researcher",
        reasoningLevel: "high",
        result: "result:second named task",
        status: "completed",
      });
    } finally {
      await harness.close();
    }
  });

  it("runs different named children in parallel without sharing history", async () => {
    const started = new Set<string>();
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    const harness = await createHarness((request) => {
      const task = request.instruction.text;
      started.add(task);
      if (started.size === 2) {
        bothStarted.resolve(undefined);
      }
      return createModelStream([
        {
          type: "text",
          text: `result:${task}`,
          waitFor: release.promise,
        },
      ]);
    });
    try {
      const [first, second] = await Promise.all([
        harness.spawn({
          agentName: "researcher",
          idempotencyKey: "parallel-1",
          input: "parallel first",
        }),
        harness.spawn({
          agentName: "reviewer",
          idempotencyKey: "parallel-2",
          input: "parallel second",
        }),
      ]);
      const processing = harness.processQueuedBatch();
      await bothStarted.promise;

      expect(started).toEqual(new Set(["parallel first", "parallel second"]));
      expect(
        Object.fromEntries(
          harness
            .requests()
            .map((request) => [request.instruction.text, request.history]),
        ),
      ).toEqual({
        "parallel first": [],
        "parallel second": [],
      });
      expect(first.childConversationId).not.toBe(second.childConversationId);
      release.resolve(undefined);
      await processing;
      await expect(
        getAgentInvocation(first.invocationId),
      ).resolves.toMatchObject({
        result: "result:parallel first",
        status: "completed",
      });
      await expect(
        getAgentInvocation(second.invocationId),
      ).resolves.toMatchObject({
        result: "result:parallel second",
        status: "completed",
      });
    } finally {
      release.resolve(undefined);
      await harness.close();
    }
  });

  it("coalesces concurrent replay and rejects a second child with the same name", async () => {
    const harness = await createHarness(taskModel);
    try {
      const replayInput = {
        agentName: "replayed",
        idempotencyKey: "same-call",
        input: "same task",
      };
      const [first, replay] = await Promise.all([
        harness.spawn(replayInput),
        harness.spawn(replayInput),
      ]);

      expect(replay.invocationId).toBe(first.invocationId);
      expect(harness.queue.sentRecords()).toHaveLength(1);

      const contention = await Promise.allSettled([
        harness.spawn({
          agentName: "taken",
          idempotencyKey: "taken-1",
          input: "first task",
        }),
        harness.spawn({
          agentName: "taken",
          idempotencyKey: "taken-2",
          input: "second task",
        }),
      ]);
      expect(
        contention.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = contention.find(
        (result) => result.status === "rejected",
      );
      expect(rejected).toMatchObject({
        reason: expect.objectContaining({
          name: "AgentNameInUseError",
        }),
        status: "rejected",
      });

      await harness.drainQueuedWork();
      expect(harness.requests()).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects new children once the parent concurrent active limit is reached", async () => {
    const harness = await createHarness(taskModel);
    try {
      const active = await Promise.all(
        Array.from(
          { length: MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT },
          (_, index) =>
            harness.spawn({
              idempotencyKey: `limit-${index}`,
              input: `active task ${index}`,
            }),
        ),
      );
      expect(active).toHaveLength(MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT);

      await expect(
        harness.spawn({
          idempotencyKey: "limit-overflow",
          input: "one too many",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);

      // Idempotent replay of an in-flight invocation must not count as new fan-out.
      await expect(
        harness.spawn({
          idempotencyKey: "limit-0",
          input: "active task 0",
        }),
      ).resolves.toMatchObject({
        invocationId: active[0]?.invocationId,
      });

      await harness.drainQueuedWork();

      await expect(
        harness.spawn({
          idempotencyKey: "limit-after-drain",
          input: "room again",
        }),
      ).resolves.toMatchObject({
        status: "pending",
      });
      await harness.drainQueuedWork();
    } finally {
      await harness.close();
    }
  });

  it("keeps a successful parallel child independent from a failing sibling", async () => {
    const harness = await createHarness((request) =>
      createModelStream([
        request.instruction.text === "failing sibling"
          ? { type: "error", errorMessage: "sibling failed" }
          : { type: "text", text: "successful sibling result" },
      ]),
    );
    try {
      const [successful, failing] = await Promise.all([
        harness.spawn({
          idempotencyKey: "sibling-success",
          input: "successful sibling",
        }),
        harness.spawn({
          idempotencyKey: "sibling-failure",
          input: "failing sibling",
        }),
      ]);
      await harness.drainQueuedWork();

      expect(
        harness
          .requests()
          .map((request) => request.instruction.text)
          .sort(),
      ).toEqual(["failing sibling", "successful sibling"].sort());
      await expect(
        getAgentInvocation(successful.invocationId),
      ).resolves.toMatchObject({
        result: "successful sibling result",
        status: "completed",
      });
      await expect(
        getAgentInvocation(failing.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "sibling failed",
        status: "failed",
      });
      const listed = await listAgents();
      expect(listed.agents).toHaveLength(2);
      expect(listed.agents).toEqual(
        expect.arrayContaining([
          {
            conversation_id: successful.childConversationId,
            last_result: "completed",
            status: "idle",
            task: "successful sibling",
            updated_at: expect.any(String),
          },
          {
            conversation_id: failing.childConversationId,
            error: "sibling failed",
            last_result: "failed",
            status: "idle",
            task: "failing sibling",
            updated_at: expect.any(String),
          },
        ]),
      );
    } finally {
      await harness.close();
    }
  });

  it("wakes a child with its own timer by the same rules as a root Conversation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const harness = await createHarness(taskModel);
    try {
      const child = await harness.spawn({
        agentName: "watcher",
        idempotencyKey: "watch-1",
        input: "Watch the deploy.",
      });
      await harness.drainQueuedWork();

      const childTools = createEventTools(
        { ...context(), conversationId: child.childConversationId },
        getEventCatalog(),
      );
      const timer = (await execute(
        childTools.watchTimer!,
        { afterMs: 60_000, intent: "Check the deploy again." },
        "child-timer",
      )) as { id: string };
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      // The event batch waits for its burst window, as on a root.
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();

      // The timer runs on the child as the event Actor, with an event Source
      // and the grants of the person who set it.
      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      const timerRun = requests[1]!;
      expect(timerRun).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: child.childConversationId,
        credentialContext: {
          actor: EVENT_SYSTEM_ACTOR,
          subject: expect.objectContaining({
            binding: expect.objectContaining({
              conversationId: child.childConversationId,
              watchId: timer.id,
            }),
          }),
        },
        parentConversationId,
        source: {
          kind: "event",
          eventType: "timer.fired",
          namespace: "junior",
        },
      });
      // Its result is saved on its own agent invocation for the parent.
      await expect(getAgentInvocation(timerRun.runId!)).resolves.toMatchObject({
        agentName: "watcher",
        childConversationId: child.childConversationId,
        parentConversationId,
        result: expect.stringContaining("Check the deploy again."),
        status: "completed",
      });
      // The timer Turn counts toward the automated-turn limit, as on a root.
      await expect(
        getAutomatedTurnLimitState({
          conversationId: child.childConversationId,
        }),
      ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });
      // listAgents still shows the task from the parent.
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "idle", task: "Watch the deploy." }],
      });

      // A stop of the idle child ends its watches and records the stop, so
      // a timer event that already reached it is dropped, and a later timer
      // never fires.
      await execute(
        childTools.watchTimer!,
        { afterMs: 60_000, intent: "Check once more." },
        "child-timer-2",
      );
      await execute(
        childTools.watchTimer!,
        { afterMs: 600_000, intent: "Check much later." },
        "child-timer-3",
      );
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      const stopAgent = createStopAgentTool(parentConversationId);
      await expect(
        stopAgent.execute!({ conversation_id: child.childConversationId }, {}),
      ).resolves.toMatchObject({ stopped: true });
      await expect(execute(childTools.listWatches!, {})).resolves.toEqual({
        subscriptions: [],
      });
      clock.mockReturnValue(clock() + 600_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      await harness.drainQueuedWork();
      expect(harness.requests()).toHaveLength(2);
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "stopped" }],
      });

      // A message from the parent starts the child again and resets its
      // automated-turn count, and its new watches work.
      await harness.message({
        childConversationId: child.childConversationId,
        idempotencyKey: "message-1",
        input: "Watch the deploy again.",
      });
      await harness.drainQueuedWork();
      await expect(
        getAutomatedTurnLimitState({
          conversationId: child.childConversationId,
        }),
      ).resolves.toMatchObject({ consecutiveAutomatedTurns: 0 });
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "idle" }],
      });
      await execute(
        childTools.watchTimer!,
        { afterMs: 60_000, intent: "Check after the restart." },
        "child-timer-4",
      );
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();
      expect(harness.requests().map((request) => request.source.kind)).toEqual([
        "agent_invocation",
        "event",
        "agent_invocation",
        "event",
      ]);
    } finally {
      clock.mockRestore();
      await harness.close();
    }
  });
});
