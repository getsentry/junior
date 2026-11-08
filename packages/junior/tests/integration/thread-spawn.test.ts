import { createSlackSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/create";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { completeAgentInvocation } from "@/chat/agent-invocations/store";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createArchiveAgentTool } from "@/chat/tools/runtime/archive-agent";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import {
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  createHarness,
  finishInvocation,
  sendPersonMessage,
  startThread,
  type Harness,
} from "../fixtures/thread-input";

const parentRun: AgentRun = {
  actor: slackInvocationInput.actor,
  conversationId: slackParentConversationId,
  destination: slackDestination,
  instruction: { text: "Coordinate the work." },
  source: createSlackSource({
    channelId: "C123",
    teamId: "T123",
    threadTs: "1712345.0001",
    visibility: "public",
  }),
  turnId: "parent-turn",
};

/**
 * Create one child, then run `withOpenWork` while the child still has its
 * first task, and finish that task, as a finished spawn leaves the child.
 */
async function createIdleChild(
  idempotencyKey: string,
  kind: "task" | "thread",
  options: {
    parentConversationId?: string;
    withOpenWork?: (childConversationId: string) => Promise<unknown>;
  } = {},
) {
  const invocation = await createAgentInvocation({
    ...slackInvocationInput,
    idempotencyKey,
    kind,
    parentConversationId:
      options.parentConversationId ?? slackParentConversationId,
  });
  await options.withOpenWork?.(invocation.childConversationId);
  await completeAgentInvocation({
    invocationId: invocation.invocationId,
    result: "Done.",
    status: "completed",
  });
  return invocation.childConversationId;
}

async function archiveAgent(
  conversationId: string,
  childConversationId: string,
  options: { apply_to_children?: boolean; person_asked?: boolean } = {},
) {
  const tool = createArchiveAgentTool(conversationId);
  return await tool.execute!(
    tool.prepareArguments!({
      conversation_id: childConversationId,
      ...options,
    }),
    {},
  );
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
    try {
      const tool = createSpawnAgentTool(
        bindSpawnAgent(parentRun, {
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        })!,
        { owner: "none" },
      );
      const thread = await tool.execute!(
        tool.prepareArguments!({
          kind: "thread",
          task: "Own the rollout plan.",
          title: "Rollout plan",
        }),
        { toolCallId: "call-thread" },
      );
      const task = await tool.execute!(
        tool.prepareArguments!({
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
      });
      await expect(
        harness.conversationStore.get({ conversationId: task.conversation_id }),
      ).resolves.toMatchObject({ kind: "task" });
      // A child never changes kind: a replay of the same spawn as a Task
      // is refused.
      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "parent-turn:call-thread",
          input: "Own the rollout plan.",
          kind: "task",
          title: "Rollout plan",
        }),
      ).rejects.toThrow("idempotency key was reused with different input");
    } finally {
      await harness.close();
    }
  });

  it("counts each Thread toward the cap until it is archived", async () => {
    const harness = await createHarness();
    try {
      // An idle Task does not count.
      await createIdleChild("idle-task", "task");
      const threads: string[] = [];
      for (
        let index = 0;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        threads.push(await createIdleChild(`thread-${index}`, "thread"));
      }

      // Idle Threads still count: people can give them work at any time.
      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "one-too-many",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
      // A Thread already counts, so new work for it needs no new slot.
      await expect(
        createAgentInvocationForMessage({
          ...slackInvocationInput,
          childConversationId: threads[0]!,
          idempotencyKey: "more-for-thread",
          parentToolCallId: "call-more",
        }),
      ).resolves.toMatchObject({ queued: false });

      await archiveAgent(slackParentConversationId, threads[1]!);
      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "after-archive",
        }),
      ).resolves.toMatchObject({ status: "pending" });
    } finally {
      await harness.close();
    }
  });

  it("archives only an idle Thread of this conversation", async () => {
    const harness = await createHarness();
    try {
      const task = await createIdleChild("task", "task");
      await expect(
        archiveAgent(slackParentConversationId, task),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("is a Task"),
      });

      const thread = await startThread(harness, "thread-spawn");
      const nestedThread = await createIdleChild("nested-thread", "thread", {
        parentConversationId: thread,
      });
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
      await harness.process(thread);
      await finishInvocation(harness, thread);

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
      // searchAgents shows the kind of each child.
      const listed = await createSearchAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {});
      expect(listed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conversation_id: thread, kind: "thread" }),
          expect.objectContaining({ conversation_id: task, kind: "task" }),
        ]),
      );

      // A person messaged the idle Thread after its last result.
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("a person still uses it"),
      });
      await expect(
        archiveAgent(slackParentConversationId, thread, {
          apply_to_children: true,
          person_asked: true,
        }),
      ).resolves.toMatchObject({ conversation_id: thread });
    } finally {
      await harness.close();
    }
  });

  it("archives a Thread with its children only when asked to", async () => {
    const harness = await createHarness();
    try {
      let child = "";
      const thread = await createIdleChild("thread", "thread", {
        withOpenWork: async (parentConversationId) => {
          child = await createIdleChild("thread-child", "task", {
            parentConversationId,
          });
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
