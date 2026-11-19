import { afterEach, describe, expect, it } from "vitest";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { getSqlExecutor } from "@/chat/db";
import { setTodoStatusByUser } from "@/chat/todos/store";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createUpdateTodosTool } from "@/chat/tools/runtime/update-todos";
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
      idempotencyKey: "todos-child",
      input: "Review the draft",
    },
    { conversationStore, queue: work.queue, state: work.state },
  );
  const { findMentionedUserId } = createSlackReviewItemToolServices(
    () => work.queue,
  );
  const tool = createUpdateTodosTool(
    { conversationId: parentConversationId },
    findMentionedUserId,
  );
  const childContext = {
    conversationId: child.childConversationId,
    parentConversationId,
  };
  const childListAgents = createListAgentsTool(childContext);
  const childUpdateTodos = createUpdateTodosTool(
    childContext,
    findMentionedUserId,
  );
  return {
    childConversationId: child.childConversationId,
    close: async () => await fixture.close(),
    updateTodos: async (input: unknown) =>
      await tool.execute!(tool.prepareArguments!(input) as never, {}),
    childListAgents: async () =>
      await childListAgents.execute!({} as never, {}),
    childUpdateTodos: async (input: unknown) =>
      await childUpdateTodos.execute!(
        childUpdateTodos.prepareArguments!(input) as never,
        {},
      ),
  };
}

describe("updateTodos", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps To-dos with their assignees across calls", async () => {
    const harness = await createHarness();
    try {
      const reviewer = await signedInViewer("reviewer@example.com");
      const added = await harness.updateTodos({
        add: [
          { title: "Write the brief" },
          {
            title: "Review the draft",
            notes: "Check the error states.",
            assignee: "Echo",
          },
          { title: "Approve the release", assignee: "reviewer@example.com" },
          { title: "Added by mistake" },
          { title: "Port the old theme", status: "dropped" },
        ],
      });
      const [brief, review, approval, mistake] = added.todos;
      expect(added.todos).toMatchObject([
        { title: "Write the brief", status: "open", assignee: "self" },
        {
          title: "Review the draft",
          notes: "Check the error states.",
          status: "open",
          assignee: "Echo",
        },
        {
          title: "Approve the release",
          status: "open",
          assignee: "reviewer@example.com",
        },
        { title: "Added by mistake", status: "open", assignee: "self" },
        { title: "Port the old theme", status: "dropped", assignee: "self" },
      ]);

      // The child is the assignee by name or by conversation_id.
      await expect(
        harness.updateTodos({
          update: [
            { id: brief!.id, status: "done" },
            {
              id: review!.id,
              assignee: harness.childConversationId,
              notes: null,
            },
          ],
          remove: [mistake!.id],
        }),
      ).resolves.toEqual({
        todos: [
          { ...brief, status: "done" },
          {
            id: review!.id,
            title: "Review the draft",
            status: "open",
            assignee: "Echo",
          },
        ],
        removed_ids: [mistake!.id],
      });

      // A call with no changes lists only the open To-dos.
      await expect(harness.updateTodos({})).resolves.toEqual({
        todos: [
          {
            id: review!.id,
            title: "Review the draft",
            status: "open",
            assignee: "Echo",
          },
          approval,
        ],
      });

      // The child reads the parent's open To-dos, with assignees from its own
      // view, but its updateTodos changes only its own To-dos.
      const { agents } = await harness.childListAgents();
      expect(agents.find((agent) => agent.relation === "parent")).toMatchObject(
        {
          conversation_id: parentConversationId,
          todos: [
            { id: review!.id, status: "open", assignee: "self" },
            { ...approval },
          ],
        },
      );
      await expect(
        harness.childUpdateTodos({
          update: [{ id: approval!.id, status: "done" }],
        }),
      ).rejects.toThrow(ToolInputError);
      await expect(harness.childUpdateTodos({})).resolves.toEqual({
        todos: [],
      });

      // A person's status that the agent replaces shows in the result, since
      // no later To-do delta can show it.
      await setTodoStatusByUser(getSqlExecutor(), {
        conversationId: parentConversationId,
        id: approval!.id,
        nowMs: Date.now(),
        status: "done",
        userId: reviewer.id,
      });
      await expect(
        harness.updateTodos({
          update: [{ id: approval!.id, status: "open" }],
        }),
      ).resolves.toEqual({
        todos: [approval],
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

  it("rejects an assignee that is not a child agent and an id that changes twice", async () => {
    const harness = await createHarness();
    try {
      const { todos } = await harness.updateTodos({
        add: [{ title: "Write the brief" }, { title: "Run the checks" }],
      });

      await expect(
        harness.updateTodos({
          add: [{ title: "Check the logs", assignee: "local:test:stranger" }],
        }),
      ).rejects.toThrow(ToolInputError);
      await expect(
        harness.updateTodos({
          update: [{ id: todos[0]!.id, status: "done" }],
          remove: [todos[0]!.id],
        }),
      ).rejects.toThrow(/once per call/);
      // Only open, done, and dropped are statuses.
      await expect(
        harness.updateTodos({
          update: [{ id: todos[1]!.id, status: "in_progress" }],
        }),
      ).rejects.toThrow(/open.*done.*dropped/s);
      await expect(harness.updateTodos({})).resolves.toEqual({ todos });
    } finally {
      await harness.close();
    }
  });
});
