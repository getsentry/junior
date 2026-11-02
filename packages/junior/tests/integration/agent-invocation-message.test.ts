import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationId,
  getAgentInvocationIdForMessage,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { stopChildAgentInvocations } from "@/chat/agent-invocations/stop";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
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

/** Read the Event messages, such as agent messages, in one mailbox. */
async function eventMessages(
  conversationId: string,
): Promise<InboundMessage[]> {
  const work = await getConversationWorkState({
    conversationId,
    state: getStateAdapter(),
  });
  return work?.messages.filter((message) => message.source === "event") ?? [];
}

/**
 * Integration tests do not run the agent. This runner reads each run and
 * stops it, so the work retries.
 */
function readRunsAgentRunner() {
  const runs: AgentRun[] = [];
  return {
    agentRunner: {
      run: async (run: AgentRun): Promise<never> => {
        runs.push(run);
        throw new Error("stop after reading the run");
      },
    },
    runs,
  };
}

describe("messageAgent", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("gives a busy child more work and lets a child message its parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const parent = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(parent.agentRunner);
    const { queue, state } = harness;
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        agentName: "researcher",
        modelProfile: "handoff",
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
      await expect(
        getAgentInvocation(
          getAgentInvocationId(
            slackParentConversationId,
            "parent-turn:call-message",
          ),
        ),
      ).resolves.toMatchObject({ modelProfile: "handoff" });
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
      // The parent Turn runs after the Event burst window.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await harness.process(queue.takeMessageFor(slackParentConversationId));
      vi.mocked(Date.now).mockRestore();
      expect(parent.runs).toEqual([
        expect.objectContaining({ actor: parentActor }),
      ]);

      // The first work finishes. The queued message reports for both.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "First pass done.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await expect(
        createListAgentsTool({ conversationId: slackParentConversationId })
          .execute!({}, {}),
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
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const { queue, state } = harness;
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
      const messages = await eventMessages(child.childConversationId);
      expect(messages).toHaveLength(1);
      // A stop after the send does not drop the message.
      await stopChildAgentInvocations({
        childConversationId: helper.childConversationId,
        parentConversationId: child.childConversationId,
      });
      // The message starts and runs a new agent invocation on the child.
      await harness.process(queue.takeMessageFor(child.childConversationId));
      const started = await getAgentInvocation(
        getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
      );
      expect(started).toMatchObject({
        childConversationId: child.childConversationId,
        input: expect.stringContaining("Halfway there."),
        parentConversationId: slackParentConversationId,
        status: "running",
      });
      expect(runner.runs).toEqual([
        expect.objectContaining({ runId: started!.invocationId }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("drops a grandchild message when the tree of its parent is stopped", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const harness = await createConversationWorkHarness(neverRunAgentRunner());
    const { queue, state } = harness;
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
      // The `replaced` result was never reported, so it is not a result.
      const { agents } = (await createListAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {})) as { agents: Record<string, unknown>[] };
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ status: "stopped" });
      expect(agents[0]).not.toHaveProperty("last_result");
      const messages = await eventMessages(child.childConversationId);
      expect(messages).toHaveLength(1);
      await expect(
        harness.process(queue.takeMessageFor(child.childConversationId)),
      ).resolves.toMatchObject({ status: "completed" });
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
