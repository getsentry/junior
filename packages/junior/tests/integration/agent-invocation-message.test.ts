import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import {
  startAgentInvocationsForChildResults,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationIdForMessage,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { stopChildAgentInvocations } from "@/chat/agent-invocations/stop";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

const parentActor = slackInvocationInput.actor;

function parentRun(): AgentRun {
  return {
    actor: parentActor,
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
}

/** The Run of one child agent invocation, as the invocation worker builds it. */
function childRun(invocation: AgentInvocation): AgentRun {
  return {
    actor: invocation.actor,
    conversationId: invocation.childConversationId,
    destination: invocation.destination,
    instruction: { text: invocation.input },
    runId: invocation.invocationId,
    source: invocation.source,
    turnId: `agent-invocation:${invocation.invocationId}`,
  };
}

function context(
  conversationId: string,
  messages: InboundMessage[],
): ConversationWorkerContext {
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
  };
}

describe("messageAgent", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("gives a busy child more work and lets a child message its parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        agentName: "researcher",
        idempotencyKey: "message-child",
        parentToolCallId: "call-spawn",
      });
      const running = (await markAgentInvocationRunning(child.invocationId))!;

      // Parent to busy child: the message waits for the current work.
      const parentTool = createMessageAgentTool(
        bindMessageAgent(parentRun(), { queue, state })!,
      );
      const sendFromParent = async (to: string, toolCallId: string) =>
        await parentTool.execute!(
          { text: "Also check the retry path.", to },
          { toolCallId },
        );
      await expect(
        sendFromParent("researcher", "call-message"),
      ).resolves.toEqual({
        conversation_id: child.childConversationId,
        delivery: "queued",
      });
      // A replayed tool call, here by conversation id, queues no second
      // message.
      await expect(
        sendFromParent(child.childConversationId, "call-message"),
      ).resolves.toEqual({
        conversation_id: child.childConversationId,
        delivery: "queued",
      });
      expect(await mailbox(child.childConversationId)).toHaveLength(1);
      await expect(sendFromParent("nobody", "call-unknown")).rejects.toThrow(
        /"nobody" is not "parent" or a child agent/,
      );

      // Child to parent: the message wakes the parent as the child's Actor.
      const childTool = createMessageAgentTool(
        bindMessageAgent(childRun(running), { queue, state })!,
      );
      await expect(
        childTool.execute!(
          { text: "Found the bug in the retry path.", to: "parent" },
          { toolCallId: "call-to-parent" },
        ),
      ).resolves.toEqual({
        conversation_id: slackParentConversationId,
        delivery: "queued",
      });
      await childTool.execute!(
        { text: "Found the bug in the retry path.", to: "parent" },
        { toolCallId: "call-to-parent" },
      );
      const parentMessages = await mailbox(slackParentConversationId);
      expect(parentMessages).toHaveLength(1);
      expect(parentMessages[0]).toMatchObject({
        delivery: "defer",
        input: {
          metadata: {
            event: { eventType: "agent.message", namespace: "junior" },
            kind: "event",
          },
        },
        source: "event",
      });
      expect(parentMessages[0]!.input.text).toContain(
        "It is not a message from a person",
      );
      expect(parentMessages[0]!.input.text).toContain(
        "Found the bug in the retry path.",
      );
      const turn = await withAgentInvocationResultActors(
        (await resolveMailboxTurnWork(
          context(slackParentConversationId, parentMessages),
        ))!,
      );
      expect(turn).toMatchObject({
        batch: [{ actor: parentActor }],
        kind: "mailbox",
      });

      // The first work finishes. The queued message reports for both.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "First pass done.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await expect(
        createListAgentsTool(slackParentConversationId).execute!({}, {}),
      ).resolves.toMatchObject({
        agents: [
          {
            conversation_id: child.childConversationId,
            name: "researcher",
            status: "pending",
            task: "Also check the retry path.",
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  it("starts a new agent invocation when a grandchild messages a child, even after a stop", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-message-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-message-helper",
        parentConversationId: child.childConversationId,
      });
      const runningHelper = (await markAgentInvocationRunning(
        helper.invocationId,
      ))!;
      const helperTool = createMessageAgentTool(
        bindMessageAgent(childRun(runningHelper), { queue, state })!,
      );
      await helperTool.execute!(
        { text: "Halfway there.", to: "parent" },
        { toolCallId: "call-halfway" },
      );
      const messages =
        (
          await getConversationWorkState({
            conversationId: child.childConversationId,
            state,
          })
        )?.messages.filter((message) => message.source === "event") ?? [];
      expect(messages).toHaveLength(1);
      // A stop after the send does not drop the message.
      await stopChildAgentInvocations({
        childConversationId: helper.childConversationId,
        parentConversationId: child.childConversationId,
      });
      // A retried delivery starts the same agent invocation.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          startAgentInvocationsForChildResults(
            context(child.childConversationId, messages),
            { queue, state },
          ),
        ).resolves.toEqual({ status: "completed" });
      }
      await expect(
        getAgentInvocation(
          getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
        ),
      ).resolves.toMatchObject({
        childConversationId: child.childConversationId,
        parentConversationId: slackParentConversationId,
        status: "pending",
      });
      expect(
        (await getAgentInvocation(
          getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
        ))!.input,
      ).toContain("Halfway there.");
    } finally {
      await fixture.close();
    }
  });

  it("drops a grandchild message when the tree of its parent is stopped", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "stopped-tree-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "stopped-tree-helper",
        parentConversationId: child.childConversationId,
      });
      const runningHelper = (await markAgentInvocationRunning(
        helper.invocationId,
      ))!;
      await createMessageAgentTool(
        bindMessageAgent(childRun(runningHelper), { queue, state })!,
      ).execute!(
        { text: "Late finding.", to: "parent" },
        { toolCallId: "call-late" },
      );
      // The child finishes while its helper is open, so its result is
      // `replaced`. Then the parent stops the whole child tree.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "Waiting on the helper.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await stopChildAgentInvocations({
        childConversationId: child.childConversationId,
        parentConversationId: slackParentConversationId,
      });
      const messages =
        (
          await getConversationWorkState({
            conversationId: child.childConversationId,
            state,
          })
        )?.messages.filter((message) => message.source === "event") ?? [];
      expect(messages).toHaveLength(1);
      await expect(
        startAgentInvocationsForChildResults(
          context(child.childConversationId, messages),
          { queue, state },
        ),
      ).resolves.toEqual({ status: "completed" });
      await expect(
        getAgentInvocation(
          getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
