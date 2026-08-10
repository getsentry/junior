import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { AgentRunRequest } from "@/chat/agent/request";
import type { PiMessage } from "@/chat/pi/messages";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import {
  getAgentInvocation,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/store";
import {
  createAgentInvocationWorker,
  routeAgentInvocationWork,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import type { CreateAgentInvocationInput } from "@/chat/agent-invocations/types";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS } from "@/chat/task-execution/store";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const parentConversationId = "local:test:agent-invocation-concurrency";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const baseInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  destinationVisibility: "private" as const,
  input: "Do the delegated work.",
  parentConversationId,
  source: createLocalSource(parentConversationId),
};

async function successfulRun(
  request: AgentRunRequest,
  result: string,
): Promise<ReturnType<typeof completedAgentRun>> {
  const timestamp = Date.now();
  const runningMessages = [
    ...(request.input.piMessages ?? []),
    {
      role: "user",
      content: [{ type: "text", text: request.input.messageText }],
      timestamp,
    },
  ] as PiMessage[];
  const persisted = await saveTurnCheckpoint({
    mode: "running",
    conversationId: request.conversationId,
    destination: request.routing.destination,
    messages: runningMessages,
    actor: request.routing.actor,
    turnId: request.turnId,
    sliceId: 1,
    source: request.routing.source,
    surface: "internal",
  });
  if (!persisted) {
    throw new Error("Expected running child session to persist");
  }
  const piMessages = [
    ...runningMessages,
    {
      role: "assistant",
      content: [{ type: "text", text: result }],
      timestamp: timestamp + 1,
    },
  ] as PiMessage[];
  return completedAgentRun({
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "integration-agent",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
    piMessages,
    text: result,
  });
}

async function createHarness(
  run: (
    request: AgentRunRequest,
  ) => Promise<ReturnType<typeof completedAgentRun>>,
) {
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
  const route = routeAgentInvocationWork({
    fallbackWorker: vi.fn(async () => ({ status: "completed" as const })),
    invocationWorker: createAgentInvocationWorker({
      agentRunner: { run },
    }),
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
    queue,
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
    const requests: AgentRunRequest[] = [];
    const harness = await createHarness(async (request) => {
      requests.push(request);
      await request.durability?.onInputCommitted?.();
      return await successfulRun(
        request,
        `result:${request.input.messageText}`,
      );
    });
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
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.input.piMessages)).toEqual([
        [],
        [],
      ]);
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

  it("reuses one named child and supplies its completed history", async () => {
    const requests: AgentRunRequest[] = [];
    const harness = await createHarness(async (request) => {
      requests.push(request);
      await request.durability?.onInputCommitted?.();
      return await successfulRun(
        request,
        `result:${request.input.messageText}`,
      );
    });
    try {
      const first = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "named-1",
        input: "first named task",
        reasoningLevel: "high",
      });
      await harness.drainQueuedWork();
      const second = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "named-2",
        input: "second named task",
        reasoningLevel: "medium",
      });
      await harness.drainQueuedWork();

      expect(second.childConversationId).toBe(first.childConversationId);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.input.piMessages).toEqual([]);
      expect(requests[0]?.policy?.reasoningLevel).toBe("high");
      expect(requests[0]?.policy?.disabledFeatures).toEqual([
        "handoff",
        "interactive-auth",
        "subagents",
      ]);
      expect(requests[1]?.policy?.reasoningLevel).toBe("medium");
      expect(requests[1]?.policy?.disabledFeatures).toEqual([
        "handoff",
        "interactive-auth",
        "subagents",
      ]);
      expect(requests[1]?.input.piMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );
      expect(JSON.stringify(requests[1]?.input.piMessages)).toContain(
        "result:first named task",
      );
      await expect(
        getAgentInvocation(second.invocationId),
      ).resolves.toMatchObject({
        reasoningLevel: "medium",
        result: "result:second named task",
        status: "completed",
      });
    } finally {
      await harness.close();
    }
  });

  it("runs different named children in parallel without sharing history", async () => {
    const started = new Set<string>();
    const histories = new Map<string, PiMessage[] | undefined>();
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const harness = await createHarness(async (request) => {
      started.add(request.input.messageText);
      histories.set(request.input.messageText, request.input.piMessages);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started.size === 2) {
        bothStarted?.();
      }
      await blocked;
      active -= 1;
      await request.durability?.onInputCommitted?.();
      return await successfulRun(
        request,
        `result:${request.input.messageText}`,
      );
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
      await startedPromise;

      expect(maxActive).toBe(2);
      expect(Object.fromEntries(histories)).toEqual({
        "parallel first": [],
        "parallel second": [],
      });
      expect(first.childConversationId).not.toBe(second.childConversationId);
      release?.();
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
      release?.();
      await harness.close();
    }
  });

  it("coalesces concurrent replay and rejects overlapping work for one name", async () => {
    const run = vi.fn(async (request: AgentRunRequest) => {
      await request.durability?.onInputCommitted?.();
      return await successfulRun(request, "completed once");
    });
    const harness = await createHarness(run);
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
          agentName: "busy",
          idempotencyKey: "busy-1",
          input: "first busy task",
        }),
        harness.spawn({
          agentName: "busy",
          idempotencyKey: "busy-2",
          input: "second busy task",
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
          name: "AgentInvocationBusyError",
        }),
        status: "rejected",
      });

      await harness.drainQueuedWork();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects new children once the parent concurrent active limit is reached", async () => {
    const harness = await createHarness(async (request) => {
      await request.durability?.onInputCommitted?.();
      return await successfulRun(
        request,
        `result:${request.input.messageText}`,
      );
    });
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
    const attempts = new Map<string, number>();
    const harness = await createHarness(async (request) => {
      const task = request.input.messageText;
      attempts.set(task, (attempts.get(task) ?? 0) + 1);
      if (task === "failing sibling") {
        throw new Error("sibling failed");
      }
      await request.durability?.onInputCommitted?.();
      return await successfulRun(request, "successful sibling result");
    });
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

      expect(attempts.get("successful sibling")).toBe(1);
      expect(attempts.get("failing sibling")).toBe(
        CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
      );
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
    } finally {
      await harness.close();
    }
  });
});
