import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import {
  createAgentInvocationForMessage,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/create";
import {
  createAndEnqueueAgentInvocation,
  enqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import type { CreateAgentInvocationInput } from "@/chat/agent-invocations/types";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const parentConversationId = "local:test:agent-invocation-limits";
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

/**
 * Compose production Conversation work under a local root. Integration tests
 * do not run the agent: the runner reads each run and stops it, so a child's
 * work retries until its last try ends its agent invocation.
 */
async function createHarness() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  const runs: AgentRun[] = [];
  const work = await createConversationWorkHarness({
    run: async (run) => {
      runs.push(run);
      throw new Error("stop after reading the run");
    },
  });
  const { queue, state } = work;
  // This harness runs only child work.
  const processNext = async () => {
    const message = queue.takeMessage();
    if (message.conversationId !== parentConversationId) {
      await work.process(message);
    }
  };
  const processQueuedBatch = async () => {
    await Promise.all(queue.queuedMessages().map(processNext));
  };

  return {
    async close() {
      await fixture.close();
    },
    async drainQueuedWork() {
      while (queue.hasQueuedMessages()) {
        await processQueuedBatch();
      }
    },
    processQueuedBatch,
    /** Send one parent message to an existing child, as messageAgent does. */
    message: async (args: {
      childConversationId: string;
      idempotencyKey: string;
      input: string;
    }) => {
      const created = await createAgentInvocationForMessage({
        ...baseInput,
        ...args,
        parentToolCallId: args.idempotencyKey,
      });
      await enqueueAgentInvocation(created.invocation, {
        conversationStore,
        queue,
        state,
      });
      return created;
    },
    queue,
    requests: (): AgentRun[] => runs,
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

describe("agent invocation names and limits", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("coalesces concurrent replay and rejects a second child with the same name", async () => {
    const harness = await createHarness();
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

      await harness.processQueuedBatch();
      expect(harness.requests()).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("rejects new children once the parent concurrent active limit is reached", async () => {
    const harness = await createHarness();
    try {
      const idle = await harness.spawn({
        idempotencyKey: "limit-idle",
        input: "idle task",
      });
      await harness.drainQueuedWork();

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

      // A message to an idle child makes it active, so it needs room.
      await expect(
        harness.message({
          childConversationId: idle.childConversationId,
          idempotencyKey: "limit-idle-message",
          input: "wake the idle child",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);

      // A busy child already counts, so a message to it queues.
      await expect(
        harness.message({
          childConversationId: active[0]!.childConversationId,
          idempotencyKey: "limit-busy-message",
          input: "more for the busy child",
        }),
      ).resolves.toMatchObject({ queued: true });

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

      // A nested coordinator's own open work does not count as one of its
      // children, so it can still start the full cap of children.
      const coordinator = await harness.spawn({
        idempotencyKey: "limit-coordinator",
        input: "coordinate nested work",
      });
      await Promise.all(
        Array.from(
          { length: MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT },
          (_, index) =>
            harness.spawn({
              idempotencyKey: `limit-nested-${index}`,
              input: `nested task ${index}`,
              parentConversationId: coordinator.childConversationId,
            }),
        ),
      );
      await expect(
        harness.spawn({
          idempotencyKey: "limit-nested-overflow",
          input: "one too many nested",
          parentConversationId: coordinator.childConversationId,
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
    } finally {
      await harness.close();
    }
  });
});
