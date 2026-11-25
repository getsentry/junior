import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import type { AgentUpdate } from "@/chat/agent-invocations/agent-update";
import { getSqlExecutor } from "@/chat/db";
import {
  dropPendingMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { renderTodoDelta } from "@/chat/todos/prompt";
import { listTodos, setTodoStatusByUser } from "@/chat/todos/store";
import { parseTodoRef } from "@/chat/todos/tool-output";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createUpdateTodosTool } from "@/chat/tools/runtime/update-todos";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
  createPublishChildTurn,
} from "../fixtures/agent-invocations";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { signedInViewer } from "../fixtures/user";

async function createHarness() {
  const { conversationStore, fixture } = await prepareParentConversation();
  const work = await createConversationWorkHarness(neverRunAgentRunner());
  const spawn = async (agentName: string) =>
    (
      await spawnChildAgent(
        {
          ...invocationInput,
          agentName,
          idempotencyKey: `todos-${agentName}`,
          input: "Review the draft",
          parentToolCallId: `todos-${agentName}`,
          parentTurnId: "parent-turn",
        },
        { conversationStore, queue: work.queue, state: work.state },
      )
    ).childConversationId;
  const childConversationId = await spawn("Echo");
  const { findMentionedUserId } = createSlackInboxItemToolServices(
    () => work.queue,
  );
  const tool = createUpdateTodosTool(
    { conversationId: parentConversationId },
    findMentionedUserId,
  );
  const childContext = {
    conversationId: childConversationId,
    parentConversationId,
  };
  const childListAgents = createListAgentsTool(childContext);
  const childUpdateTodos = createUpdateTodosTool(
    childContext,
    findMentionedUserId,
  );
  const publishChildTurn = createPublishChildTurn({
    queue: work.queue,
    state: work.state,
  });
  /** A child's Turn takes its input before it reports. */
  const takeInput = async (conversationId: string) => {
    const pending =
      (await getConversationWorkState({ conversationId, state: work.state }))
        ?.messages ?? [];
    await dropPendingMessages({
      conversationId,
      inboundMessageIds: pending.map((message) => message.inboundMessageId),
      state: work.state,
    });
  };
  return {
    childConversationId,
    spawn,
    work,
    /** Sends one child Turn's result to the parent, as its loop does. */
    send: async (conversationId: string, update: AgentUpdate) => {
      await takeInput(conversationId);
      await publishChildTurn({
        actor: invocationInput.actor,
        conversationId,
        turnId: "turn_child",
        update,
      });
    },
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
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("keeps To-dos with their assignees across calls", async () => {
    const harness = await createHarness();
    try {
      const reviewer = await signedInViewer("reviewer@example.com");
      const added = await harness.updateTodos({
        // One assignee can have more than one To-do in progress.
        add: [
          { title: "Write the brief", status: "in_progress" },
          {
            title: "Review the draft",
            notes: "Check the error states.",
            assignee: "Echo",
          },
          { title: "Approve the release", assignee: "reviewer@example.com" },
          { title: "Added by mistake", status: "in_progress" },
          { title: "Port the old theme", status: "dropped" },
        ],
      });
      const [brief, review, approval, mistake] = added.todos;
      expect(added.todos).toMatchObject([
        { title: "Write the brief", status: "in_progress", assignee: "self" },
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
        {
          title: "Added by mistake",
          status: "in_progress",
          assignee: "self",
        },
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
              status: "in_progress",
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
            status: "in_progress",
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
            status: "in_progress",
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
            { id: review!.id, status: "in_progress", assignee: "self" },
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
        id: parseTodoRef(approval!.id),
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
      // The old Plan statuses are gone.
      await expect(
        harness.updateTodos({
          update: [{ id: todos[1]!.id, status: "blocked" }],
        }),
      ).rejects.toThrow(/open.*in_progress.*done.*dropped/s);
      // Ids are `TODO-<n>`, so a reply cannot pass one off as a GitHub `#12`.
      expect(todos[0]!.id).toMatch(/^TODO-\d+$/);
      await expect(harness.updateTodos({ remove: ["#12"] })).rejects.toThrow(
        /TODO-12/,
      );
      await expect(
        harness.updateTodos({ remove: ["TODO-999999"] }),
      ).rejects.toThrow("No To-do has id TODO-999999.");
      await expect(harness.updateTodos({})).resolves.toEqual({ todos });
    } finally {
      await harness.close();
    }
  });
  it("lets a child close only its own To-dos of the parent", async () => {
    const harness = await createHarness();
    try {
      const { todos } = await harness.updateTodos({
        add: [
          { title: "Review the draft", assignee: "Echo" },
          { title: "Review the tests", assignee: "Echo" },
          { title: "Write the brief" },
        ],
      });
      const [draft, tests, brief] = todos;
      const seen = Math.max(
        ...(await listTodos(getSqlExecutor(), parentConversationId)).map(
          (todo) => todo.version,
        ),
      );

      await expect(
        harness.childUpdateTodos({
          update: [{ id: draft!.id, status: "done" }],
        }),
      ).resolves.toEqual({
        todos: [{ ...draft, status: "done", assignee: "self" }],
      });
      // A child only closes its own: no other field, and no other status.
      await expect(
        harness.childUpdateTodos({
          update: [{ id: tests!.id, status: "done", title: "Renamed" }],
        }),
      ).rejects.toThrow(/Set only its status, to done or dropped/);
      await expect(
        harness.childUpdateTodos({
          update: [{ id: tests!.id, status: "in_progress" }],
        }),
      ).rejects.toThrow(ToolInputError);
      await expect(
        harness.childUpdateTodos({
          update: [{ id: brief!.id, status: "done" }],
        }),
      ).rejects.toThrow(ToolInputError);

      // The parent sees the child's change in its next To-do delta.
      const parentTodos = await listTodos(
        getSqlExecutor(),
        parentConversationId,
      );
      expect(parentTodos.map((todo) => [todo.title, todo.status])).toEqual([
        ["Review the draft", "done"],
        ["Review the tests", "open"],
        ["Write the brief", "open"],
      ]);
      expect(renderTodoDelta(parentTodos, seen)).toBe(
        [
          "<todo-delta>",
          `To-do version ${parentTodos[0]!.version}. Others changed these To-dos since you last saw them. Each To-do shows its current fields.`,
          `- ${draft!.id} (done, assignee Echo, changed by child agent Echo): Review the draft`,
          "</todo-delta>",
        ].join("\n"),
      );
    } finally {
      await harness.close();
    }
  });

  it("closes a child's open To-dos once its completed or stopped result reaches the parent after them", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const tick = () => vi.setSystemTime(Date.now() + 1_000);
    const harness = await createHarness();
    try {
      const children = {
        completed: harness.childConversationId,
        stopped: await harness.spawn("Foxtrot"),
        failed: await harness.spawn("Golf"),
        blocked: await harness.spawn("Hotel"),
      };
      const reply: AgentUpdate = {
        status: "done",
        text: "Reviewed.",
      };
      tick();
      await harness.updateTodos({
        add: [
          { title: "Echo open", assignee: "Echo" },
          { title: "Echo started", assignee: "Echo", status: "in_progress" },
          { title: "Echo dropped", assignee: "Echo", status: "dropped" },
          { title: "Foxtrot open", assignee: "Foxtrot" },
          { title: "Golf open", assignee: "Golf" },
          { title: "Hotel open", assignee: "Hotel" },
          { title: "Parent open" },
        ],
      });

      tick();
      await harness.send(children.completed, reply);
      for (const kind of ["stopped", "failed", "blocked"] as const) {
        await harness.send(children[kind], {
          status: kind,
          text: `Child ${kind}.`,
        });
      }
      // A retry of the same result leaves To-dos assigned after it open.
      tick();
      await harness.updateTodos({
        add: [
          { title: "Echo next", assignee: "Echo" },
          { title: "Foxtrot next", assignee: "Foxtrot" },
        ],
      });
      tick();
      await harness.send(children.completed, reply);
      await harness.send(children.stopped, {
        status: "stopped",
        text: "Child stopped.",
      });

      const parentTodos = await listTodos(
        getSqlExecutor(),
        parentConversationId,
      );
      expect(
        parentTodos.map((todo) => [
          todo.title,
          todo.status,
          todo.changedByAgent?.name,
        ]),
      ).toEqual([
        ["Echo open", "done", "Echo"],
        ["Echo started", "done", "Echo"],
        ["Echo dropped", "dropped", undefined],
        ["Foxtrot open", "dropped", "Foxtrot"],
        ["Golf open", "open", undefined],
        ["Hotel open", "open", undefined],
        ["Parent open", "open", undefined],
        ["Echo next", "open", undefined],
        ["Foxtrot next", "open", undefined],
      ]);
    } finally {
      await harness.close();
    }
  });
});
