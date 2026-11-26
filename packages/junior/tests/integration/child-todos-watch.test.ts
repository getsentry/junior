import { afterEach, describe, expect, it, vi } from "vitest";
import { getSqlExecutor } from "@/chat/db";
import { cancelWatch, createWatch } from "@/chat/events/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { changeTodos, listTodos } from "@/chat/todos/store";
import { juniorTodos } from "@/db/schema";
import { slackParentConversationId } from "../fixtures/agent-invocations";
import { runTestHeartbeat } from "../fixtures/conversation-work";
import {
  createHarness,
  finishRun,
  sendPersonMessage,
  startThread,
} from "../fixtures/thread-input";

const WATCH_TTL_MS = 600_000;

describe("To-dos of a child agent with a Watch", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it.each(["expires", "is cancelled"] as const)(
    "keeps the To-do open while the child watches a PR, and closes it once the Watch %s",
    async (end) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const tick = () => vi.setSystemTime(Date.now() + 1_000);
      const harness = await createHarness();
      try {
        // The Thread takes its task quietly, so its parent gets nothing.
        const childId = await startThread(harness, "watch-spawn");
        harness.onRun(finishRun);
        await harness.drain(childId);
        tick();
        await changeTodos(getSqlExecutor(), {
          change: {
            add: [
              {
                assignee: { conversationId: childId },
                status: "open",
                title: "Ship the PR",
              },
            ],
            remove: [],
            update: [],
          },
          conversationId: slackParentConversationId,
          nowMs: Date.now(),
        });
        const watch = await createWatch(
          {
            conversationId: childId,
            events: ["pull_request.merged"],
            expiresAtMs: Date.now() + WATCH_TTL_MS,
            identifier: "getsentry/junior#1",
            intent: "Ship the PR.",
            label: "GitHub PR getsentry/junior#1",
            namespace: "github",
            resourceType: "pull_request",
          },
          { state: harness.state },
        );
        // The heartbeat reads stored status, as lists and search do, and
        // a read through listTodos settles results first.
        const storedStatus = async () =>
          (await getSqlExecutor().db().select().from(juniorTodos)).map(
            (todo) => [todo.title, todo.status],
          );
        const heartbeat = async () =>
          await runTestHeartbeat(harness.queue, Date.now());

        // Each Turn of the child ends done and reports to the parent. The
        // parent's Turns take the results out of its mailbox.
        for (const key of ["person-1", "person-2"]) {
          tick();
          await sendPersonMessage(harness, childId, key);
          harness.onRun(
            async (run) =>
              await finishRun(
                run,
                { reply: { text: "PR opened.", toolCallId: `${key}-reply` } },
                "PR opened.",
              ),
          );
          await harness.drain(childId);
          await expect(
            listTodos(getSqlExecutor(), slackParentConversationId),
          ).resolves.toEqual([
            expect.objectContaining({ title: "Ship the PR", status: "open" }),
          ]);
          harness.onRun(finishRun);
          await harness.drain(slackParentConversationId);
          await heartbeat();
          await expect(storedStatus()).resolves.toEqual([
            ["Ship the PR", "open"],
          ]);
        }

        if (end === "expires") {
          vi.setSystemTime(watch.expiresAtMs + 1);
        } else {
          tick();
          await cancelWatch({
            conversationId: childId,
            id: watch.id,
            state: harness.state,
          });
        }
        await heartbeat();

        await expect(storedStatus()).resolves.toEqual([
          ["Ship the PR", "done"],
        ]);
        await expect(
          listTodos(getSqlExecutor(), slackParentConversationId),
        ).resolves.toEqual([
          expect.objectContaining({
            title: "Ship the PR",
            status: "done",
            changedByAgent: expect.objectContaining({
              conversationId: childId,
            }),
          }),
        ]);
      } finally {
        await harness.close();
      }
    },
  );
});
