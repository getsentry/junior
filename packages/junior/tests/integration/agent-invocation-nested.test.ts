import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import { getAgentInvocationIdForResult } from "@/chat/agent-invocations/ids";
import { getAgentInvocation } from "@/chat/agent-invocations/store";
import { enqueueAgentInvocationResult } from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackInvocationInput,
} from "../fixtures/agent-invocations";
import { finishAgentInvocation } from "@/chat/agent-invocations/finish";

async function searchAgents(conversationId: string) {
  return (await createSearchAgentsTool({ conversationId }).execute!({}, {}))
    .agents;
}

describe("nested agent invocations", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("sends each nested task's result to its parent and sends nothing when a result continuation ends", async () => {
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
      (await finishAgentInvocation({
        invocationId,
        closingReport: result,
        status: "completed",
      })) as TerminalAgentInvocation;
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-child",
        parentToolCallId: "spawn-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-helper",
        parentConversationId: child.childConversationId,
        parentToolCallId: "spawn-helper",
      });
      const grandHelper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-grand-helper",
        parentConversationId: helper.childConversationId,
        parentToolCallId: "spawn-grand-helper",
      });

      // Each parent task gets its result, also while the child's own
      // children still run.
      for (const invocation of [child, helper]) {
        await expect(
          complete(invocation.invocationId, "Started a helper."),
        ).resolves.toMatchObject({ status: "completed" });
      }
      const grandResult = await complete(
        grandHelper.invocationId,
        "Grand helper fact: 42.",
      );
      await enqueueAgentInvocationResult(grandResult, { queue, state });

      // The result runs on the helper as the Actor that started the tree,
      // with the root Location.
      await expect(
        harness.process(queue.takeMessageFor(helper.childConversationId)),
      ).resolves.toMatchObject({ status: "failed" });
      const continuation = (await getAgentInvocation(
        getAgentInvocationIdForResult(grandResult.invocationId),
      ))!;
      expect(continuation).toMatchObject({
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
        expect.objectContaining({
          conversation_id: helper.childConversationId,
          status: "running",
          task: slackInvocationInput.input,
        }),
      ]);

      // No parent task started the continuation, so its completed result
      // is not sent. It reports with messageAgent instead.
      await complete(continuation.invocationId, "Helper fact: 42.");
      await expect(
        harness.process(queue.takeMessageFor(helper.childConversationId)),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        getAgentInvocation(continuation.invocationId),
      ).resolves.toMatchObject({ status: "completed" });
      expect(
        JSON.stringify(await mailbox(child.childConversationId)),
      ).not.toContain("Helper fact: 42.");
    } finally {
      await fixture.close();
    }
  });

  // The latest work of the child finished, and the parent is owed no result
  // for it. A result from the child's own child agent must still run.
  it.each([
    {
      // A row that an older runtime left as `replaced`. No reader reads
      // the old column, so it is a finished parent task.
      name: "a leftover replaced parent task",
      parentTask: true,
    },
    { name: "completed own work", parentTask: false },
  ])(
    "runs a grandchild result on a child whose latest work is $name",
    async ({ parentTask }) => {
      const { fixture } = await prepareSlackParentConversation();
      const harness = await createConversationWorkHarness({
        run: async () => {
          throw new Error("stop after reading the run");
        },
      });
      const { queue, state } = harness;
      try {
        const child = await createAgentInvocation({
          ...slackInvocationInput,
          agentName: "watcher",
          idempotencyKey: "leftover-child",
          ...(parentTask ? { parentToolCallId: "spawn-child" } : undefined),
        });
        const helper = await createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "leftover-helper",
          parentConversationId: child.childConversationId,
          parentToolCallId: "spawn-helper",
        });
        await expect(
          finishAgentInvocation({
            invocationId: child.invocationId,
            status: "completed",
          }),
        ).resolves.toMatchObject({ status: "completed" });
        if (parentTask) {
          await getSqlExecutor()
            .db()
            .update(juniorAgentInvocations)
            .set({ parentMailboxStatus: "replaced" })
            .where(eq(juniorAgentInvocations.invocationId, child.invocationId));
        }
        const helperResult = (await finishAgentInvocation({
          closingReport: "Helper fact: 42.",
          invocationId: helper.invocationId,
          status: "completed",
        })) as TerminalAgentInvocation;
        await enqueueAgentInvocationResult(helperResult, { queue, state });

        // The runner stops the Run after it starts.
        await harness.process(queue.takeMessageFor(child.childConversationId));
        await expect(
          getAgentInvocation(
            getAgentInvocationIdForResult(helper.invocationId),
          ),
        ).resolves.toMatchObject({
          childConversationId: child.childConversationId,
          status: "running",
        });
        await expect(
          searchAgents(slackInvocationInput.parentConversationId),
        ).resolves.toEqual([
          expect.objectContaining({
            conversation_id: child.childConversationId,
          }),
        ]);
        expect(
          (await searchAgents(slackInvocationInput.parentConversationId))[0],
        ).not.toMatchObject({ status: "stopped" });
      } finally {
        await fixture.close();
      }
    },
  );
});
