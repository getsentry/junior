import { createSlackSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/create";
import { AgentInvocationLimitError } from "@/chat/agent-invocations/errors";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import {
  completeAgentInvocation,
  getLatestAgentInvocationForConversation,
  markAgentInvocationMailboxAppended,
} from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CONVERSATION_WORK_MAX_RETRIES } from "@/chat/task-execution/store";
import { createArchiveAgentTool } from "@/chat/tools/runtime/archive-agent";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import {
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  sendParentMessage,
  spawnChildWithoutAgentInvocation,
} from "../fixtures/child-without-agent-invocation";
import {
  createHarness,
  finishInvocation,
  sendPersonMessage,
  startThread,
  type Harness,
} from "../fixtures/thread-input";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import { mockTitleModel } from "../fixtures/title-model";

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
  options: { apply_to_children?: boolean } = {},
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
        title: "Rollout plan",
      });
      await expect(
        harness.conversationStore.get({ conversationId: task.conversation_id }),
      ).resolves.toMatchObject({ kind: "task", title: "Failing test" });
      // A passed title skips title generation.
      expect(titleRequests).toBe(0);

      // A Thread without a title gets a generated one.
      const untitled = await tool.execute!(
        tool.prepareArguments!({
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

  it("counts a Thread toward the cap only while it has open work", async () => {
    const harness = await createHarness();
    try {
      // Idle children do not count, Threads included.
      await createIdleChild("idle-task", "task");
      const idleThread = await createIdleChild("idle-thread", "thread");
      const busy: AgentInvocation[] = [];
      for (
        let index = 0;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        busy.push(
          await createAgentInvocation({
            ...slackInvocationInput,
            idempotencyKey: `busy-thread-${index}`,
            kind: "thread",
          }),
        );
      }

      // Threads with open work count.
      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "one-too-many",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
      // New work makes an idle Thread active, so it needs a slot.
      await expect(
        createAgentInvocationForMessage({
          ...slackInvocationInput,
          childConversationId: idleThread,
          idempotencyKey: "more-for-idle-thread",
          parentToolCallId: "call-idle",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
      // A busy Thread already counts, so more work for it needs no new slot.
      await expect(
        createAgentInvocationForMessage({
          ...slackInvocationInput,
          childConversationId: busy[0]!.childConversationId,
          idempotencyKey: "more-for-busy-thread",
          parentToolCallId: "call-busy",
        }),
      ).resolves.toMatchObject({ queued: true });

      await completeAgentInvocation({
        invocationId: busy[1]!.invocationId,
        result: "Done.",
        status: "completed",
      });
      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "after-finish",
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

      // A person messaged the idle Thread after its last result. A later
      // write to the parent's invocation, such as a replayed mailbox
      // append, does not hand the Thread back.
      const reported = await getLatestAgentInvocationForConversation(thread);
      await markAgentInvocationMailboxAppended(
        reported!.invocationId,
        Date.now() + 60_000,
      );
      await expect(
        archiveAgent(slackParentConversationId, thread),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("a person still uses it"),
      });
      // New work from the parent gives the Thread back to the parent.
      const { invocation } = await createAgentInvocationForMessage({
        ...slackInvocationInput,
        childConversationId: thread,
        idempotencyKey: "after-person",
        parentToolCallId: "call-after-person",
      });
      await completeAgentInvocation({
        invocationId: invocation.invocationId,
        result: "Done.",
        status: "completed",
      });
      await expect(
        archiveAgent(slackParentConversationId, thread, {
          apply_to_children: true,
        }),
      ).resolves.toMatchObject({ conversation_id: thread });
    } finally {
      await harness.close();
    }
  });

  it("archives a Thread that no Agent invocation names after new parent work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const spawn = {
        actor: slackInvocationInput.actor,
        idempotencyKey: "thread-without-agent-invocation",
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
        idempotencyKey: "thread-without-agent-invocation:again",
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
