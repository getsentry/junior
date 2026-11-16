import { afterEach, describe, expect, it } from "vitest";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { getSqlExecutor } from "@/chat/db";
import { setPlanItemStatusByUser } from "@/chat/plan/store";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createUpdatePlanTool } from "@/chat/tools/runtime/update-plan";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { signedInViewer } from "../fixtures/user";

async function createHarness() {
  const { conversationStore, fixture } = await prepareParentConversation();
  const work = await createConversationWorkHarness(neverRunAgentRunner());
  const child = await createAndEnqueueAgentInvocation(
    {
      ...invocationInput,
      agentName: "Echo",
      idempotencyKey: "plan-child",
      input: "Review the draft",
    },
    { conversationStore, queue: work.queue, state: work.state },
  );
  const { findMentionedUserId } = createSlackReviewItemToolServices(
    () => work.queue,
  );
  const tool = createUpdatePlanTool(
    { conversationId: parentConversationId },
    findMentionedUserId,
  );
  const childContext = {
    conversationId: child.childConversationId,
    parentConversationId,
  };
  const childListAgents = createListAgentsTool(childContext);
  const childUpdatePlan = createUpdatePlanTool(
    childContext,
    findMentionedUserId,
  );
  return {
    childConversationId: child.childConversationId,
    close: async () => await fixture.close(),
    updatePlan: async (input: unknown) =>
      await tool.execute!(tool.prepareArguments!(input) as never, {}),
    childListAgents: async () =>
      await childListAgents.execute!({} as never, {}),
    childUpdatePlan: async (input: unknown) =>
      await childUpdatePlan.execute!(
        childUpdatePlan.prepareArguments!(input) as never,
        {},
      ),
  };
}

describe("updatePlan", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps items with their assignees across calls", async () => {
    const harness = await createHarness();
    try {
      const reviewer = await signedInViewer("reviewer@example.com");
      const added = await harness.updatePlan({
        add: [
          { title: "Write the brief", status: "in_progress" },
          {
            title: "Review the draft",
            notes: "Check the error states.",
            assignee: "Echo",
          },
          {
            title: "Approve the release",
            assignee: "reviewer@example.com",
            status: "blocked",
          },
          { title: "Added by mistake" },
        ],
      });
      const [brief, review, approval, mistake] = added.items;
      expect(added.items).toMatchObject([
        { title: "Write the brief", status: "in_progress", assignee: "self" },
        {
          title: "Review the draft",
          notes: "Check the error states.",
          status: "pending",
          assignee: "Echo",
        },
        {
          title: "Approve the release",
          status: "blocked",
          assignee: "reviewer@example.com",
        },
        { title: "Added by mistake", status: "pending", assignee: "self" },
      ]);

      // One item in progress per assignee: the child can work beside this
      // agent, by name or by conversation_id.
      await expect(
        harness.updatePlan({
          update: [
            { id: brief!.id, status: "done" },
            {
              id: review!.id,
              status: "in_progress",
              assignee: harness.childConversationId,
              notes: null,
            },
          ],
          remove: [mistake!.id],
        }),
      ).resolves.toEqual({
        items: [
          { ...brief, status: "done" },
          {
            id: review!.id,
            title: "Review the draft",
            status: "in_progress",
            assignee: "Echo",
          },
        ],
        removed_ids: [mistake!.id],
      });

      // A call with no changes lists the open items.
      await expect(harness.updatePlan({})).resolves.toEqual({
        items: [
          {
            id: review!.id,
            title: "Review the draft",
            status: "in_progress",
            assignee: "Echo",
          },
          approval,
        ],
      });

      // The child reads the parent's open items, with assignees from its own
      // view, but its updatePlan changes only its own plan.
      const { agents } = await harness.childListAgents();
      expect(agents.find((agent) => agent.relation === "parent")).toMatchObject(
        {
          conversation_id: parentConversationId,
          plan: [
            { id: review!.id, status: "in_progress", assignee: "self" },
            { ...approval },
          ],
        },
      );
      await expect(
        harness.childUpdatePlan({
          update: [{ id: approval!.id, status: "done" }],
        }),
      ).rejects.toThrow(ToolInputError);
      await expect(harness.childUpdatePlan({})).resolves.toEqual({ items: [] });

      // A person's status that the agent replaces shows in the result, since
      // no later plan delta can show it.
      await setPlanItemStatusByUser(getSqlExecutor(), {
        conversationId: parentConversationId,
        id: approval!.id,
        nowMs: Date.now(),
        status: "done",
        userId: reviewer.id,
      });
      await expect(
        harness.updatePlan({
          update: [{ id: approval!.id, status: "blocked" }],
        }),
      ).resolves.toEqual({
        items: [approval],
        replaced_person_changes: [
          {
            id: approval!.id,
            status: "done",
            changed_by: "reviewer@example.com",
          },
        ],
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects an assignee that is not a child agent and a second item in progress", async () => {
    const harness = await createHarness();
    try {
      const { items } = await harness.updatePlan({
        add: [{ title: "Write the brief", status: "in_progress" }],
      });

      await expect(
        harness.updatePlan({
          add: [{ title: "Check the logs", assignee: "local:test:stranger" }],
        }),
      ).rejects.toThrow(ToolInputError);
      await expect(
        harness.updatePlan({
          add: [{ title: "Run the checks", status: "in_progress" }],
        }),
      ).rejects.toThrow(/one item in_progress/);
      await expect(harness.updatePlan({})).resolves.toEqual({ items });
    } finally {
      await harness.close();
    }
  });
});
