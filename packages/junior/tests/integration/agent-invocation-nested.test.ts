import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
} from "@/chat/agent-invocations/store";
import { enqueueAgentInvocationResult } from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

async function listAgents(conversationId: string) {
  return (await createListAgentsTool({ conversationId }).execute!({}, {}))
    .agents;
}

describe("nested agent invocations", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("sends each nested child's report to its parent once its own children finish", async () => {
    const { fixture } = await prepareSlackParentConversation();
    // Integration tests do not run the agent. The runner reads each run and
    // stops it, so its work retries until the test finishes the invocation.
    const runs: AgentRun[] = [];
    const harness = await createConversationWorkHarness({
      run: async (run) => {
        runs.push(run);
        throw new Error("stop after reading the run");
      },
    });
    const { queue, state } = harness;
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    const complete = async (invocationId: string, result: string) =>
      (await completeAgentInvocation({
        invocationId,
        result,
        status: "completed",
      })) as TerminalAgentInvocation;
    // Production work gives a result to the parent child. That starts a new
    // agent invocation there and runs it.
    const deliver = async (result: TerminalAgentInvocation) => {
      await expect(
        harness.process(queue.takeMessageFor(result.parentConversationId)),
      ).resolves.toMatchObject({ status: "failed" });
      return (await getAgentInvocation(
        getAgentInvocationIdForResult(result.invocationId),
      ))!;
    };
    // Finish the run of one agent invocation. Its retry wake reports the
    // result to the parent.
    const finish = async (
      invocation: { childConversationId: string; invocationId: string },
      result: string,
    ) => {
      const terminal = await complete(invocation.invocationId, result);
      await expect(
        harness.process(queue.takeMessageFor(invocation.childConversationId)),
      ).resolves.toMatchObject({ status: "completed" });
      return terminal;
    };
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-helper",
        parentConversationId: child.childConversationId,
      });
      const grandHelper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-grand-helper",
        parentConversationId: helper.childConversationId,
      });

      // A child that finishes while its own child runs does not report yet.
      for (const invocation of [child, helper]) {
        await expect(
          complete(invocation.invocationId, "Started a helper."),
        ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      }
      const grandResult = await complete(
        grandHelper.invocationId,
        "Grand helper fact: 42.",
      );
      expect(grandResult).toMatchObject({ parentMailboxStatus: "pending" });
      await enqueueAgentInvocationResult(grandResult, { queue, state });

      // listAgents shows the state of open work. A `replaced` child still
      // has work.
      const listedChild = (childConversationId: string) => ({
        conversation_id: childConversationId,
        relation: "child",
        status: "pending",
        task: slackInvocationInput.input,
        updated_at: expect.any(String),
      });
      await expect(listAgents(slackParentConversationId)).resolves.toEqual([
        listedChild(child.childConversationId),
      ]);
      await expect(listAgents(child.childConversationId)).resolves.toEqual([
        listedChild(helper.childConversationId),
      ]);

      // The result runs on the helper as the Actor that started the tree,
      // with the root Location.
      const helperContinuation = await deliver(grandResult);
      expect(helperContinuation).toMatchObject({
        actor: slackInvocationInput.actor,
        childConversationId: helper.childConversationId,
        input: expect.stringContaining("Grand helper fact: 42."),
        parentConversationId: child.childConversationId,
        status: "running",
      });
      expect(runs).toEqual([
        expect.objectContaining({
          actor: slackInvocationInput.actor,
          conversationId: helper.childConversationId,
          disabledFeatures: ["handoff", "interactive-auth", "subagents"],
          location: expect.objectContaining({
            provider: "slack",
            channelId: "C123",
          }),
        }),
      ]);
      // An agent invocation that receives a result is not a new task.
      await expect(listAgents(child.childConversationId)).resolves.toEqual([
        { ...listedChild(helper.childConversationId), status: "running" },
      ]);

      // Each child reports once, from the agent invocation that received the
      // last result of its own children.
      const helperResult = await finish(helperContinuation, "Helper fact: 42.");
      const childContinuation = await deliver(helperResult);
      expect(childContinuation).toMatchObject({
        input: expect.stringContaining("Helper fact: 42."),
        parentConversationId: slackParentConversationId,
      });
      await finish(childContinuation, "Final answer: 42.");
      await expect(
        getAgentInvocation(childContinuation.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "appended" });
      expect(await mailbox(slackParentConversationId)).toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            childContinuation.invocationId,
          ),
          input: expect.objectContaining({
            text: expect.stringContaining("Final answer: 42."),
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
