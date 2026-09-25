import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationTurnId,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import {
  buildAgentInvocationInboundMessage,
  createAgentInvocationWorker,
} from "@/chat/agent-invocations/work";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
const PARENT_CONVERSATION_ID = "local:test:component-parent-agent";
const DESTINATION = {
  conversationId: PARENT_CONVERSATION_ID,
  platform: "local",
} as const;
const INVOCATION_INPUT = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination: DESTINATION,
  input: "Summarize the durable task.",
  parentConversationId: PARENT_CONVERSATION_ID,
  reasoningLevel: "medium" as const,
};

async function prepareParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: PARENT_CONVERSATION_ID,
    destination: DESTINATION,
    nowMs: 1_000,
    source: "local",
  });
  return fixture;
}

describe("agent invocation worker", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stops a stranded running child without starting another agent run", async () => {
    const fixture = await prepareParentConversation();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...INVOCATION_INPUT,
          agentName: "researcher",
          idempotencyKey: "running-no-boundary-1",
        },
        2_000,
      );
      const turnId = getAgentInvocationTurnId(created.invocationId);
      await markAgentInvocationRunning(created.invocationId);
      await upsertTurnRecord({
        actor: INVOCATION_INPUT.actor,
        conversationId: created.childConversationId,
        destination: DESTINATION,
        piMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial output" }],
            api: "responses",
            provider: "openai",
            model: "gpt-5.3",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        ] as PiMessage[],
        turnId,
        sliceId: 1,
        source: { kind: "agent_invocation" },
        state: "running",
        surface: "internal",
      });
      const worker = createAgentInvocationWorker(neverRunAgentRunner());
      const context = {
        attempt: {
          ack: vi.fn(),
          conversationId: created.childConversationId,
          drain: vi.fn(),
          isFinalAttempt: false,
          messages: [],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        shouldYield: () => false,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      expect(context.attempt.ack).not.toHaveBeenCalled();
      await expect(
        getTurnRecord(created.childConversationId, turnId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining("lost its worker"),
        state: "failed",
      });
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining("lost its worker"),
        status: "failed",
      });
      await expect(
        createAgentInvocation({
          ...INVOCATION_INPUT,
          agentName: "researcher",
          idempotencyKey: "running-no-boundary-2",
        }),
      ).resolves.toMatchObject({
        childConversationId: created.childConversationId,
        status: "pending",
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps unexpected runner failures retryable until the final attempt", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        idempotencyKey: "failure-1",
      });
      const run = vi.fn(async () => {
        throw new Error("agent runner unavailable");
      });
      const worker = createAgentInvocationWorker({ run });
      const message = buildAgentInvocationInboundMessage(created);
      const context = (isFinalAttempt: boolean, ack: () => Promise<void>) =>
        ({
          attempt: {
            ack,
            conversationId: created.childConversationId,
            drain: vi.fn(),
            isFinalAttempt,
            messages: [message],
          },
          checkIn: vi.fn(),
          conversationId: created.childConversationId,
          shouldYield: () => false,
        }) satisfies ConversationWorkerContext;
      const firstAck = vi.fn(async () => {});

      await expect(
        worker(context(false, firstAck), created.invocationId),
      ).rejects.toThrow("agent runner unavailable");
      expect(firstAck).not.toHaveBeenCalled();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ status: "running" });

      const finalAck = vi.fn(async () => {});
      await expect(
        worker(context(true, finalAck), created.invocationId),
      ).resolves.toEqual({ status: "completed" });

      expect(run).toHaveBeenCalledTimes(2);
      expect(finalAck).toHaveBeenCalledOnce();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: "agent runner unavailable",
        status: "failed",
      });
    } finally {
      await fixture.close();
    }
  });

  it("persists invariant failures on the final attempt", async () => {
    const fixture = await prepareParentConversation();
    try {
      const created = await createAgentInvocation({
        ...INVOCATION_INPUT,
        agentName: "researcher",
        idempotencyKey: "invalid-child-1",
      });
      const ack = vi.fn();
      const worker = createAgentInvocationWorker(neverRunAgentRunner());
      const context = {
        attempt: {
          ack,
          conversationId: created.childConversationId,
          destination: DESTINATION,
          drain: vi.fn(),
          isFinalAttempt: true,
          messages: [buildAgentInvocationInboundMessage(created)],
        },
        checkIn: vi.fn(),
        conversationId: created.childConversationId,
        destination: DESTINATION,
        shouldYield: () => false,
      } satisfies ConversationWorkerContext;

      await expect(worker(context, created.invocationId)).resolves.toEqual({
        status: "completed",
      });

      expect(ack).toHaveBeenCalledOnce();
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining(
          "must not own a provider destination",
        ),
        status: "failed",
      });
      await expect(
        createAgentInvocation({
          ...INVOCATION_INPUT,
          agentName: "researcher",
          idempotencyKey: "invalid-child-2",
        }),
      ).resolves.toMatchObject({
        childConversationId: created.childConversationId,
        status: "pending",
      });
    } finally {
      await fixture.close();
    }
  });
});
