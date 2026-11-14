import { createSlackSource } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentBinding } from "@/chat/agent-invocations/bindings";
import { MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT } from "@/chat/agent-invocations/create";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
} from "@/chat/agent-invocations/errors";
import {
  getAgentInvocationId,
  getSpawnedChildConversationId,
} from "@/chat/agent-invocations/ids";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import {
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
} from "@/chat/agent-invocations/store";
import { stopChildAgentsOf } from "@/chat/agent-invocations/stop";
import type { AgentRun, SpawnAgentInput } from "@/chat/agent/types";
import {
  readAgentConfig,
  writeAgentConfig,
} from "@/chat/conversations/agent-config";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { getSqlExecutor } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import { juniorAgentBindings } from "@/db/schema";
import {
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { deferred } from "../fixtures/conversation-work";
import { readProxyProperty } from "../fixtures/proxy-property";
import { SUITE_EXPERIMENTAL } from "../fixtures/experimental-setup";
import { createHarness, type Harness } from "../fixtures/thread-input";

/** The parent's Turn, as the root Turn code binds it to agent tools. */
function parentRun(turnId = "parent-turn"): AgentRun {
  return {
    actor: slackInvocationInput.actor,
    conversationId: slackParentConversationId,
    credentialContext: {
      actor: { type: "user", userId: slackInvocationInput.actor.userId },
    },
    destination: slackDestination,
    instruction: { text: "Coordinate the work." },
    source: createSlackSource({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1712345.0001",
      visibility: "public",
    }),
    turnId,
  };
}

async function spawn(
  harness: Harness,
  toolCallId: string,
  input: Partial<SpawnAgentInput> = {},
  state: StateAdapter = harness.state,
) {
  const { childConversationId } = await bindSpawnAgent(parentRun(), {
    conversationStore: harness.conversationStore,
    queue: harness.queue,
    state,
  })!({ task: "Check the deploy.", ...input }, { toolCallId });
  return childConversationId;
}

async function message(harness: Harness, to: string, toolCallId: string) {
  return await bindMessageAgent(parentRun(), {
    queue: harness.queue,
    state: harness.state,
  })!({ text: "Check it again.", to }, { toolCallId });
}

async function mailboxTexts(harness: Harness, conversationId: string) {
  return (
    (
      await getConversationWorkState({ conversationId, state: harness.state })
    )?.messages.map((entry) => entry.input.text) ?? []
  );
}

describe("spawn and messageAgent without Agent invocations", () => {
  beforeEach(() => {
    setExperimentalFeatures({
      ...SUITE_EXPERIMENTAL,
      "child-agents-without-agent-invocations": true,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("runs a spawned child's task as the parent Turn's Actor, grants, and agent config", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1", {
        kind: "thread",
        name: harness.agentName,
        reasoningLevel: "high",
        title: "Deploy check",
      });
      await harness.processUntilRun(childId);

      await expect(
        getAgentInvocation(
          getAgentInvocationId(slackParentConversationId, "parent-turn:call-1"),
        ),
      ).resolves.toBeUndefined();
      await expect(
        getAgentBinding({
          name: harness.agentName,
          parentConversationId: slackParentConversationId,
        }),
      ).resolves.toMatchObject({ childConversationId: childId });
      await expect(
        harness.conversationStore.get({ conversationId: childId }),
      ).resolves.toMatchObject({ kind: "thread", title: "Deploy check" });
      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        actor: slackInvocationInput.actor,
        conversationId: childId,
        credentialContext: parentRun().credentialContext,
        instruction: { provenance: { authority: "instruction" } },
        reasoning: "high",
      });
      expect(run.agentInvocationId).toBeUndefined();
      expect(run.instruction.text).toContain("Check the deploy.");
    } finally {
      await harness.close();
    }
  });

  it("replays a spawn by its idempotency key", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const first = await spawn(harness, "call-1", { name: harness.agentName });
      await expect(
        spawn(harness, "call-1", { name: harness.agentName }),
      ).resolves.toBe(first);

      await expect(mailboxTexts(harness, first)).resolves.toEqual([
        "Check the deploy.",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("sends the task when a spawn stopped before it reached the mailbox", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      // The spawn's transaction committed. Its worker died before the task
      // reached the child's mailbox.
      const childId = getSpawnedChildConversationId(
        slackParentConversationId,
        "parent-turn:call-1",
      );
      await harness.conversationStore.createChild({
        childConversationId: childId,
        kind: "task",
        parentConversationId: slackParentConversationId,
        source: "internal",
      });
      await getSqlExecutor().db().insert(juniorAgentBindings).values({
        childConversationId: childId,
        name: harness.agentName,
        parentConversationId: slackParentConversationId,
      });
      await writeAgentConfig(childId, {});

      await expect(
        spawn(harness, "call-1", { name: harness.agentName }),
      ).resolves.toBe(childId);
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([
        "Check the deploy.",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("refuses a spawn whose name another child uses", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      await spawn(harness, "call-1", { name: harness.agentName });

      await expect(
        spawn(harness, "call-2", { name: harness.agentName }),
      ).rejects.toBeInstanceOf(AgentNameInUseError);
    } finally {
      await harness.close();
    }
  });

  it("counts a spawned child against the parent's limit before its spawn returns", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      for (
        let index = 1;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        await spawn(harness, `call-${index}`);
      }
      // The last free spawn waits to put its task in the child's mailbox.
      // Another spawn starts while it waits.
      const appending = deferred();
      const release = deferred();
      let waited = false;
      const slowMailbox = new Proxy(harness.state, {
        get(target, prop) {
          if (prop === "acquireLock") {
            return async (key: string, ttlMs: number) => {
              if (
                !waited &&
                key.startsWith("junior:conversation:v2:mutation:agent:")
              ) {
                waited = true;
                appending.resolve();
                await release.promise;
              }
              return await target.acquireLock(key, ttlMs);
            };
          }
          const value = readProxyProperty(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const last = spawn(harness, "call-last", {}, slowMailbox);
      await appending.promise;
      const over = spawn(harness, "call-over");
      await new Promise((resolve) => setTimeout(resolve, 250));
      release.resolve();

      await expect(last).resolves.toEqual(expect.any(String));
      await expect(over).rejects.toBeInstanceOf(AgentInvocationLimitError);
    } finally {
      await harness.close();
    }
  });

  it("gives a child a parent message that writes no Agent invocation", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1", {
        agentType: "explore",
      });
      vi.setSystemTime(1_800_000_001_000);
      // The task still waits, so the message waits behind it.
      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "queued",
      });
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([
        "Check the deploy.",
        "Check it again.",
      ]);
      await expect(
        getLatestAgentInvocationForConversation(childId),
      ).resolves.toBeUndefined();
      await expect(readAgentConfig(childId)).resolves.toEqual({
        agentType: "explore",
      });
    } finally {
      await harness.close();
    }
  });

  it("ends a stopped child's stop when its parent sends it new work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });
      vi.setSystemTime(1_800_000_001_000);

      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "started",
      });
      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        undefined,
      );
      // The stop skipped the task. It stays skipped.
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([
        "Check it again.",
      ]);
      await harness.processUntilRun(childId);
      expect(harness.runs).toHaveLength(1);
      expect(harness.runs[0]!.instruction.text).toContain("Check it again.");
    } finally {
      await harness.close();
    }
  });

  it("stops a child again when its parent messaged it after the parent's own stop", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      // A person stops the parent and its tree. The parent's run sees its
      // stop late, after it messaged the child.
      await markConversationsStopped([slackParentConversationId, childId], {
        cancelWatches: false,
        state: harness.state,
      });
      vi.setSystemTime(1_800_000_001_000);
      await message(harness, childId, "call-2");
      await stopChildAgentsOf(slackParentConversationId, harness.state);

      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        1_800_000_000_000,
      );
      await harness.drain(childId);
      expect(harness.runs).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
