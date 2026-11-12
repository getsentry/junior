import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import {
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
} from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import {
  enqueueAgentInvocationResult,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendInboundMessage,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

async function searchAgents(conversationId: string) {
  return (await createSearchAgentsTool({ conversationId }).execute!({}, {}))
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
    // A completed agent invocation sends nothing, so each one here ends
    // blocked, which still reports.
    const complete = async (invocationId: string, report: string) =>
      (await completeAgentInvocation({
        errorMessage: report,
        invocationId,
        status: "blocked",
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
      await expect(
        complete(child.invocationId, "Started a helper."),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      // A completed row saved before `reply` existed still sends its text,
      // so the helper waits for it too.
      const grandResult = (await completeAgentInvocation({
        invocationId: grandHelper.invocationId,
        result: "Grand helper fact: 42.",
        status: "completed",
      })) as TerminalAgentInvocation;
      expect(grandResult).toMatchObject({ parentMailboxStatus: "pending" });
      await expect(
        complete(helper.invocationId, "Started a helper."),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await enqueueAgentInvocationResult(grandResult, { queue, state });

      // searchAgents shows the state of open work. A `replaced` child still
      // has work, so it shows no result and no error.
      const listedChild = (childConversationId: string) => ({
        conversation_id: childConversationId,
        kind: "task",
        relation: "child",
        status: "pending",
        task: slackInvocationInput.input,
        updated_at: expect.any(String),
      });
      await expect(searchAgents(slackParentConversationId)).resolves.toEqual([
        listedChild(child.childConversationId),
      ]);
      await expect(searchAgents(child.childConversationId)).resolves.toEqual([
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
          disabledFeatures: ["interactive-auth", "subagents"],
          location: expect.objectContaining({
            provider: "slack",
            channelId: "C123",
          }),
        }),
      ]);
      // An agent invocation that receives a result is not a new task.
      await expect(searchAgents(child.childConversationId)).resolves.toEqual([
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

  it("sends a child's report when its helper ends without a reply", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const harness = await createConversationWorkHarness({
      run: async () => {
        throw new Error("The agent does not run in this test.");
      },
    });
    const { queue, state } = harness;
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "quiet-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "quiet-helper",
        parentConversationId: child.childConversationId,
      });
      await expect(
        completeAgentInvocation({
          errorMessage: "Started a helper.",
          invocationId: child.invocationId,
          status: "blocked",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });

      // A sibling's reply that still waits in another child's mailbox starts
      // a later agent invocation there, so that child does not report yet.
      const busy = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "busy-child",
      });
      const [busyQuiet, busyReplied] = await Promise.all(
        ["busy-quiet", "busy-replied"].map((idempotencyKey) =>
          createAgentInvocation({
            ...slackInvocationInput,
            idempotencyKey,
            parentConversationId: busy.childConversationId,
          }),
        ),
      );
      await completeAgentInvocation({
        errorMessage: "Started helpers.",
        invocationId: busy.invocationId,
        status: "blocked",
      });
      await enqueueChildResultToParent({
        result: {
          kind: "reply",
          reply: { text: "Sibling finding.", toolCallId: "call-reply" },
        },
        messageKey: "call-reply",
        queue,
        sender: busyReplied!,
        state,
      });
      for (const [invocation, result] of [
        [busyReplied!, "Sibling finding."],
        [busyQuiet!, ""],
      ] as const) {
        await enqueueAgentInvocationResult(
          (await completeAgentInvocation({
            invocationId: invocation.invocationId,
            result,
            status: "completed",
          })) as TerminalAgentInvocation,
          { queue, state },
        );
      }
      await expect(
        getAgentInvocation(busy.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });

      // A person's message in a Thread starts no agent invocation, so it
      // does not hold the report.
      await appendInboundMessage({
        message: {
          conversationId: child.childConversationId,
          createdAtMs: Date.now(),
          delivery: "defer",
          inboundMessageId: "web:quiet-child:person",
          input: { text: "Any update?" },
          receivedAtMs: Date.now(),
          source: "web",
        },
        state,
      });

      // The helper ends with `noReply`, so it sends the child nothing. No
      // later agent invocation of the child would send its report.
      const quiet = (await completeAgentInvocation({
        invocationId: helper.invocationId,
        result: "",
        status: "completed",
      })) as TerminalAgentInvocation;
      await enqueueAgentInvocationResult(quiet, { queue, state });

      expect(
        (
          await getConversationWorkState({
            conversationId: child.childConversationId,
            state,
          })
        )?.messages.map((message) => message.source),
      ).toEqual(["web"]);
      await expect(
        getAgentInvocation(child.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "appended" });
      expect(
        (
          await getConversationWorkState({
            conversationId: slackParentConversationId,
            state,
          })
        )?.messages,
      ).toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            child.invocationId,
          ),
          input: expect.objectContaining({
            text: expect.stringContaining("Started a helper."),
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
