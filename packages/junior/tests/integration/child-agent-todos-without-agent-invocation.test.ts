import { afterEach, describe, expect, it, vi } from "vitest";
import { getSqlExecutor } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { changeTodos, listTodos } from "@/chat/todos/store";
import {
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { spawnChildWithoutAgentInvocation } from "../fixtures/child-without-agent-invocation";
import {
  createHarness,
  finishRun,
  sendPersonMessage,
  type Harness,
} from "../fixtures/thread-input";

describe("To-dos of child agents that no Agent invocation names", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  async function spawnChild(
    harness: Harness,
    idempotencyKey: string,
    input: Partial<Parameters<typeof spawnChildWithoutAgentInvocation>[0]> = {},
  ) {
    return await spawnChildWithoutAgentInvocation({
      actor: slackInvocationInput.actor,
      conversationStore: harness.conversationStore,
      idempotencyKey,
      parentConversationId: slackParentConversationId,
      queue: harness.queue,
      state: harness.state,
      ...input,
    });
  }

  it("closes the parent's To-dos of a child once its reply ends its work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      const assignTodo = async (title: string) => {
        vi.setSystemTime(Date.now() + 1_000);
        await changeTodos(getSqlExecutor(), {
          change: {
            add: [
              { assignee: { conversationId: childId }, status: "open", title },
            ],
            remove: [],
            update: [],
          },
          conversationId: slackParentConversationId,
          nowMs: Date.now(),
        });
      };
      const readTodos = async () =>
        (await listTodos(getSqlExecutor(), slackParentConversationId)).map(
          (todo) => [
            todo.title,
            todo.status,
            todo.changedByAgent?.conversationId,
          ],
        );
      await assignTodo("Check the deploy");
      // The child still has its task, so the To-do stays open.
      await expect(readTodos()).resolves.toEqual([
        ["Check the deploy", "open", undefined],
      ]);
      vi.setSystemTime(Date.now() + 1_000);
      harness.onRun(
        async (run) =>
          await finishRun(
            run,
            { finalText: "Deploy is green." },
            "Deploy is green.",
          ),
      );
      await harness.drain(childId);
      // A To-do given to the idle child after its work ends stays open.
      await assignTodo("Watch the canary");

      const expected = [
        ["Check the deploy", "done", childId],
        ["Watch the canary", "open", undefined],
      ];
      await expect(readTodos()).resolves.toEqual(expected);
      await expect(readTodos()).resolves.toEqual(expected);
    } finally {
      await harness.close();
    }
  });

  it("closes the parent's To-do of a Thread after a person's Turn there", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        kind: "thread",
      });
      // The Thread takes its task quietly, so its parent gets nothing.
      harness.onRun(finishRun);
      await harness.drain(childId);
      vi.setSystemTime(Date.now() + 1_000);
      await changeTodos(getSqlExecutor(), {
        change: {
          add: [
            {
              assignee: { conversationId: childId },
              status: "open",
              title: "Check the deploy",
            },
          ],
          remove: [],
          update: [],
        },
        conversationId: slackParentConversationId,
        nowMs: Date.now(),
      });

      // A person's Turn in the Thread also reports to the parent, which
      // closes the To-do.
      vi.setSystemTime(Date.now() + 1_000);
      await sendPersonMessage(harness, childId, "person-1");
      harness.onRun(
        async (run) =>
          await finishRun(
            run,
            { reply: { text: "It is green.", toolCallId: "reply-1" } },
            "It is green.",
          ),
      );
      await harness.drain(childId);

      await expect(
        listTodos(getSqlExecutor(), slackParentConversationId),
      ).resolves.toEqual([
        expect.objectContaining({ title: "Check the deploy", status: "done" }),
      ]);
    } finally {
      await harness.close();
    }
  });
});
