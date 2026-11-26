import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildAgentLimitError,
  AgentNameInUseError,
} from "@/chat/child-agents/errors";
import {
  MAX_ACTIVE_CHILD_AGENTS,
  messageChildAgent,
  spawnChildAgent,
} from "@/chat/child-agents/create";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  slackSpawnInput,
  slackParentConversationId,
} from "../fixtures/child-agents";
import {
  createHarness,
  finishRun,
  type Harness,
} from "../fixtures/thread-input";

/** Spawn one child agent, as startAgent does. */
async function spawn(
  harness: Harness,
  idempotencyKey: string,
  input: { agentName?: string; parentConversationId?: string } = {},
) {
  const { childConversationId } = await spawnChildAgent(
    {
      ...slackSpawnInput,
      ...input,
      idempotencyKey,
      input: `Task ${idempotencyKey}.`,
      parentToolCallId: idempotencyKey,
      parentTurnId: idempotencyKey,
    },
    {
      conversationStore: harness.conversationStore,
      queue: harness.queue,
      state: harness.state,
    },
  );
  return childConversationId;
}

/** Send one parent message to a child, as messageAgent does. */
async function message(
  harness: Harness,
  childConversationId: string,
  idempotencyKey: string,
) {
  return await messageChildAgent(
    {
      actor: slackSpawnInput.actor,
      childConversationId,
      idempotencyKey,
      input: "More work.",
      parentConversationId: slackParentConversationId,
      parentToolCallId: idempotencyKey,
      parentTurnId: idempotencyKey,
    },
    { queue: harness.queue, state: harness.state },
  );
}

/** Spawn the cap of children below one parent at the same time. */
async function spawnFullCap(
  harness: Harness,
  prefix: string,
  parentConversationId?: string,
) {
  return await Promise.all(
    Array.from({ length: MAX_ACTIVE_CHILD_AGENTS }, (_, index) =>
      spawn(
        harness,
        `${prefix}-${index}`,
        parentConversationId ? { parentConversationId } : {},
      ),
    ),
  );
}

describe("child agent names and limits", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("coalesces a concurrent spawn replay and refuses a second child with the same name", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const [first, replay] = await Promise.all([
        spawn(harness, "same-call", { agentName: "replayed" }),
        spawn(harness, "same-call", { agentName: "replayed" }),
      ]);
      expect(replay).toBe(first);

      const contention = await Promise.allSettled([
        spawn(harness, "taken-1", { agentName: "taken" }),
        spawn(harness, "taken-2", { agentName: "taken" }),
      ]);
      const spawned = contention.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(spawned).toHaveLength(1);
      expect(
        contention.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: expect.any(AgentNameInUseError) });

      // The replay ran no second task.
      harness.onRun(finishRun);
      await harness.drain(first);
      await harness.drain(spawned[0]!);
      expect(harness.runs.map((run) => run.conversationId)).toEqual([
        first,
        spawned[0],
      ]);
    } finally {
      await harness.close();
    }
  });

  it("refuses new work for an idle child once the parent has the cap of active children", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    harness.onRun(finishRun);
    try {
      const idle = await spawn(harness, "limit-idle");
      await harness.drain(idle);
      const active = await spawnFullCap(harness, "limit");

      await expect(spawn(harness, "limit-overflow")).rejects.toBeInstanceOf(
        ChildAgentLimitError,
      );
      // A replay of an open spawn is not new fan-out.
      await expect(spawn(harness, "limit-0")).resolves.toBe(active[0]);
      // A message to an idle child makes it active, so it needs room.
      await expect(
        message(harness, idle, "limit-idle-message"),
      ).rejects.toBeInstanceOf(ChildAgentLimitError);
      // A busy child already counts, so a message to it queues.
      await expect(
        message(harness, active[0]!, "limit-busy-message"),
      ).resolves.toEqual({ delivery: "queued" });

      for (const childId of active) {
        await harness.drain(childId);
      }
      // Finished children free their room.
      const coordinator = await spawn(harness, "limit-coordinator");

      // A nested coordinator's own open work does not count as one of its
      // children, so it can still start the full cap of children.
      await spawnFullCap(harness, "limit-nested", coordinator);
      await expect(
        spawn(harness, "limit-nested-overflow", {
          parentConversationId: coordinator,
        }),
      ).rejects.toBeInstanceOf(ChildAgentLimitError);
    } finally {
      await harness.close();
    }
  });
});
