import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
  messageChildAgent,
} from "@/chat/agent-invocations/create";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CONVERSATION_WORK_MAX_RETRIES } from "@/chat/task-execution/store";
import { createArchiveAgentTool } from "@/chat/tools/runtime/archive-agent";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStartAgentTool } from "@/chat/tools/runtime/start-agent";
import {
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  sendParentMessage,
  spawnChildWithoutAgentInvocation,
} from "../fixtures/child-without-agent-invocation";
import {
  createHarness,
  finishRun,
  sendPersonMessage,
  slackParentRun,
  startThread,
  type Harness,
} from "../fixtures/thread-input";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import { mockTitleModel } from "../fixtures/title-model";

const parentRun = slackParentRun();

/** Run a child's queued task until its Turn ends without a `reply`. */
async function finishTask(harness: Harness, conversationId: string) {
  harness.onRun(finishRun);
  await harness.drain(conversationId);
  harness.onRun(undefined);
}

/** Spawn one child of a parent, as `startAgent` does. */
async function spawnChild(
  harness: Harness,
  idempotencyKey: string,
  kind: "task" | "thread",
  parentConversationId = slackParentConversationId,
) {
  return await spawnChildWithoutAgentInvocation({
    actor: slackInvocationInput.actor,
    conversationStore: harness.conversationStore,
    idempotencyKey,
    kind,
    parentConversationId,
    queue: harness.queue,
    state: harness.state,
  });
}

/**
 * Create one child, then run `withOpenWork` while the child still has its
 * first task, and finish that task, as a finished spawn leaves the child.
 */
async function createIdleChild(
  harness: Harness,
  idempotencyKey: string,
  kind: "task" | "thread",
  options: {
    parentConversationId?: string;
    withOpenWork?: (childConversationId: string) => Promise<unknown>;
  } = {},
) {
  const childConversationId = await spawnChild(
    harness,
    idempotencyKey,
    kind,
    options.parentConversationId,
  );
  await options.withOpenWork?.(childConversationId);
  await finishTask(harness, childConversationId);
  return childConversationId;
}

/** Give a child more work, as `messageAgent` does. */
async function messageChild(
  harness: Harness,
  childConversationId: string,
  idempotencyKey: string,
) {
  return await messageChildAgent(
    {
      actor: slackInvocationInput.actor,
      childConversationId,
      idempotencyKey,
      input: "Check it again.",
      parentConversationId: slackParentConversationId,
      parentToolCallId: idempotencyKey,
      parentTurnId: idempotencyKey,
    },
    { queue: harness.queue, state: harness.state },
  );
}

async function archiveAgent(
  conversationId: string,
  childConversationId: string,
  options: { apply_to_children?: boolean } = {},
) {
  const tool = createArchiveAgentTool(conversationId);
  return await tool.execute!(
    tool.prepareArguments({
      conversation_id: childConversationId,
      ...options,
    }),
    {},
  );
}

/** Run a Thread's queued Turn until its last try fails, as the runner throws. */
async function failQueuedTurn(harness: Harness, conversationId: string) {
  for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
    await harness.drain(conversationId);
    await runHeartbeatAfterLeasesExpire(harness.queue);
  }
}

async function archivedAtMs(harness: Harness, conversationId: string) {
  return (await harness.conversationStore.get({ conversationId }))
    ?.archivedAtMs;
}

describe("Thread spawn and archive", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("spawns a Thread when the parent asks for one and a Task by default", async () => {
    const harness = await createHarness();
    let titleRequests = 0;
    mockTitleModel("Generated rollout title", {
      onRequest: () => {
        titleRequests++;
      },
    });
    try {
      const tool = createStartAgentTool(
        bindSpawnAgent(parentRun, {
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        })!,
        { owner: "none" },
      );
      const thread = await tool.execute!(
        tool.prepareArguments({
          kind: "thread",
          task: "Own the rollout plan.",
          title: "Rollout plan",
        }),
        { toolCallId: "call-thread" },
      );
      const task = await tool.execute!(
        tool.prepareArguments({
          kind: null,
          task: "Check the failing test.",
          title: "Failing test",
        }),
        { toolCallId: "call-task" },
      );

      await expect(
        harness.conversationStore.get({
          conversationId: thread.conversation_id,
        }),
      ).resolves.toMatchObject({
        kind: "thread",
        parentConversationId: slackParentConversationId,
        title: "Rollout plan",
      });
      await expect(
        harness.conversationStore.get({
          conversationId: task.conversation_id,
        }),
      ).resolves.toMatchObject({ kind: "task", title: "Failing test" });
      // A passed title skips title generation.
      expect(titleRequests).toBe(0);

      // A Thread without a title gets a generated one.
      const untitled = await tool.execute!(
        tool.prepareArguments({
          kind: "thread",
          task: "Own the rollout follow-ups.",
        }),
        { toolCallId: "call-untitled-thread" },
      );
      expect(titleRequests).toBe(1);
      await expect(
        harness.conversationStore.get({
          conversationId: untitled.conversation_id,
        }),
      ).resolves.toMatchObject({
        kind: "thread",
        title: "Generated rollout title",
      });
      // A child never changes kind: a replay of the same spawn as a Task
      // is refused.
      await expect(
        tool.execute!(
          tool.prepareArguments({
            kind: null,
            task: "Own the rollout plan.",
            title: "Rollout plan",
          }),
          { toolCallId: "call-thread" },
        ),
      ).rejects.toThrow("idempotency key was reused with different input");
    } finally {
      await harness.close();
    }
  });

  it("counts a Thread toward the cap only while it has open work", async () => {
    const harness = await createHarness();
    try {
      // Idle children do not count, Threads included.
      await createIdleChild(harness, "idle-task", "task");
      const idleThread = await createIdleChild(
        harness,
        "idle-thread",
        "thread",
      );
      const busy: string[] = [];
      for (
        let index = 0;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        busy.push(await spawnChild(harness, `busy-thread-${index}`, "thread"));
      }

      // Threads with open work count.
      await expect(
        spawnChild(harness, "one-too-many", "task"),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
      // New work makes an idle Thread active, so it needs a slot.
      await expect(
        messageChild(harness, idleThread, "more-for-idle-thread"),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
      // A busy Thread already counts, so more work for it needs no new slot.
      await expect(
        messageChild(harness, busy[0]!, "more-for-busy-thread"),
      ).resolves.toEqual({ delivery: "queued" });

      await finishTask(harness, busy[1]!);
      await expect(
        spawnChild(harness, "after-finish", "task"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      await harness.close();
    }
  });

  it("archives only an idle child agent of this conversation", async () => {
    const harness = await createHarness();
    try {
      // A Task is archived the same way as a Thread.
      const task = await createIdleChild(harness, "task", "task");
      await expect(
        archiveAgent(slackParentConversationId, task),
      ).resolves.toMatchObject({ conversation_id: task });

      const thread = await startThread(harness, "thread-spawn");
      const nestedThread = await spawnChild(
        harness,
        "nested-thread",
        "thread",
        thread,
      );
      // Only the direct parent archives a Thread.
      await expect(
        archiveAgent(slackParentConversationId, nestedThread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("is not a child agent"),
      });

      // The parent's own open work is in use.
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("is working"),
      });
      await finishTask(harness, thread);

      // So is a person's message that waits to run.
      await expect(
        sendPersonMessage(harness, thread, "person-1"),
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("is working"),
      });
      await harness.drain(thread);
      await expect(archivedAtMs(harness, thread)).resolves.toBeUndefined();
      // listAgents shows the kind of each child.
      const listed = await createListAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {});
      expect(listed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conversation_id: thread, kind: "thread" }),
          expect.objectContaining({ conversation_id: task, kind: "task" }),
        ]),
      );
    } finally {
      await harness.close();
    }
  });

  it("gives a Thread that a person messaged back to its parent with new parent work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const spawn = {
        actor: slackInvocationInput.actor,
        idempotencyKey: "thread-person-then-parent",
        parentConversationId: slackParentConversationId,
        queue: harness.queue,
        state: harness.state,
      };
      const thread = await spawnChildWithoutAgentInvocation({
        ...spawn,
        conversationStore: harness.conversationStore,
        kind: "thread",
      });
      await failQueuedTurn(harness, thread);
      vi.setSystemTime(Date.now() + 1_000);
      await sendPersonMessage(harness, thread, "person-1");
      await failQueuedTurn(harness, thread);
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        message: expect.stringContaining("a person still uses it"),
      });

      // New work from the parent gives the Thread back to the parent.
      vi.setSystemTime(Date.now() + 1_000);
      await sendParentMessage({
        ...spawn,
        childConversationId: thread,
        idempotencyKey: "thread-person-then-parent:again",
      });
      await failQueuedTurn(harness, thread);
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).resolves.toMatchObject({ conversation_id: thread });
    } finally {
      vi.useRealTimers();
      await harness.close();
    }
  });

  it("archives a Thread with its children only when asked to", async () => {
    const harness = await createHarness();
    try {
      let child = "";
      const thread = await createIdleChild(harness, "thread", "thread", {
        withOpenWork: async (parentConversationId) => {
          // The Task still works, so it sends the Thread no result yet.
          child = await spawnChild(
            harness,
            "thread-child",
            "task",
            parentConversationId,
          );
        },
      });

      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("Pass apply_to_children"),
      });
      await expect(archivedAtMs(harness, thread)).resolves.toBeUndefined();

      const archived = await archiveAgent(slackParentConversationId, thread, {
        apply_to_children: true,
      });
      const atMs = Date.parse(archived.archived_at);
      await expect(archivedAtMs(harness, thread)).resolves.toBe(atMs);
      await expect(archivedAtMs(harness, child)).resolves.toBe(atMs);
      // A repeated archive keeps the first one.
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).resolves.toEqual(archived);
    } finally {
      await harness.close();
    }
  });
});
