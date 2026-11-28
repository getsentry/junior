import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { bindMessageAgent } from "@/chat/child-agents/message";
import { readParentMessage } from "@/chat/child-agents/parent-message-input";
import { resultAuthorId } from "@/chat/child-agents/sender-actors";
import { bindSpawnAgent } from "@/chat/child-agents/spawn";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { appendAndEnqueueWebMessage } from "@/chat/conversations/web-input";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getSqlExecutor } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  startConversationWork,
} from "@/chat/task-execution/store";
import { changeTodos, listTodos } from "@/chat/todos/store";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createStartAgentTool } from "@/chat/tools/runtime/start-agent";
import { slackParentConversationId } from "../fixtures/child-agents";
import { webTestActor } from "../fixtures/conversation";
import { mailboxTexts, message, spawn } from "../fixtures/parent-agent-tools";
import { readProxyProperty } from "../fixtures/proxy-property";
import {
  commitRunInput,
  createHarness,
  finishRun,
  runInputCheckpoint,
  sendPersonMessage,
  type Harness,
} from "../fixtures/thread-input";

describe("a person's stop of a child agent", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it.each([
    {
      input: "new parent work",
      send: (harness: Harness, threadId: string) =>
        message(harness, threadId, "call-2"),
      text: "Check it again.",
    },
    {
      input: "a person's message",
      send: (harness: Harness, threadId: string) =>
        sendPersonMessage(harness, threadId, "person-1"),
      text: "What did you find?",
    },
  ])(
    "runs only $input after a person stops a Thread with a waiting task",
    async ({ send, text }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const threadId = await spawn(harness, "call-1", { kind: "thread" });
        vi.setSystemTime(1_800_000_001_000);
        await stopConversation({
          conversationId: threadId,
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        });

        vi.setSystemTime(1_800_000_002_000);
        await send(harness, threadId);
        harness.onRun(finishRun);
        await harness.drain(threadId);

        expect(harness.runs).toHaveLength(1);
        expect(harness.runs[0]!.instruction.text).toContain(text);
        expect(harness.runs[0]!.instruction.text).not.toContain(
          "Check the deploy.",
        );
      } finally {
        await harness.close();
      }
    },
  );

  it("lets a person's Turn in a stopped Thread give work to its child agents, but not a Turn from before the stop", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    // The `startAgent` and `messageAgent` tools that a Turn of the Thread
    // gets.
    const agentTools = (run: AgentRun) => ({
      startAgent: createStartAgentTool(
        bindSpawnAgent(run, {
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        })!,
        { owner: "none" },
      ),
      messageAgent: createMessageAgentTool(
        bindMessageAgent(run, { queue: harness.queue, state: harness.state })!,
      ),
    });
    const giveWork = async (run: AgentRun, helperId: string, key: string) => {
      const { startAgent, messageAgent } = agentTools(run);
      return await Promise.allSettled([
        startAgent.execute!(
          startAgent.prepareArguments({
            task: "Check the metrics.",
            title: "Metrics",
          }),
          { toolCallId: `${key}:start` },
        ),
        messageAgent.execute!(
          { text: "Check the logs again.", to: helperId },
          { toolCallId: `${key}:message` },
        ),
      ]);
    };
    try {
      const threadId = await spawn(harness, "call-1", { kind: "thread" });
      // The Thread's task Turn starts a helper.
      let taskRun: AgentRun | undefined;
      let helperId = "";
      harness.onRun(async (run) => {
        taskRun = run;
        await commitRunInput(run);
        const { startAgent } = agentTools(run);
        ({ conversation_id: helperId } = await startAgent.execute!(
          startAgent.prepareArguments({
            task: "Check the logs.",
            title: "Logs",
          }),
          { toolCallId: "task:start" },
        ));
        return await finishRun(run);
      });
      await harness.drain(threadId);

      const stoppedAtMs = 1_800_000_002_000;
      vi.setSystemTime(stoppedAtMs);
      await stopConversation({
        conversationId: threadId,
        conversationStore: harness.conversationStore,
        queue: harness.queue,
        state: harness.state,
      });

      // The task Turn started before the stop, so it gives no work.
      await expect(giveWork(taskRun!, helperId, "late")).resolves.toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringContaining("is stopped"),
          }),
        },
        {
          status: "fulfilled",
          value: expect.objectContaining({ delivery: "noted" }),
        },
      ]);

      // A person's message that was sent before the stop arrives after it.
      // It runs, and the Thread stays stopped.
      vi.setSystemTime(1_800_000_003_000);
      await appendAndEnqueueWebMessage(
        {
          actor: webTestActor,
          conversationId: threadId,
          idempotencyKey: "person-1",
          message: "What did you find?",
        },
        {
          conversationStore: harness.conversationStore,
          nowMs: 1_800_000_001_000,
          queue: harness.queue,
          state: harness.state,
        },
      );
      let personWork: Awaited<ReturnType<typeof giveWork>> | undefined;
      harness.onRun(async (run) => {
        await commitRunInput(run);
        personWork = await giveWork(run, helperId, "person");
        return await finishRun(run);
      });
      await harness.drain(threadId);

      expect(harness.runs.at(-1)).toMatchObject({ source: { kind: "web" } });
      await expect(getConversationStoppedAtMs(threadId)).resolves.toBe(
        stoppedAtMs,
      );
      expect(personWork).toEqual([
        {
          status: "fulfilled",
          value: expect.objectContaining({
            conversation_id: expect.any(String),
          }),
        },
        {
          status: "fulfilled",
          value: expect.objectContaining({ delivery: "started" }),
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { kind: "task", when: "waits" },
    { kind: "task", when: "runs" },
    { kind: "thread", when: "waits" },
    { kind: "thread", when: "runs" },
  ] as const)(
    "tells the parent once that a person stopped a $kind while it $when",
    async ({ kind, when }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const taskId = await spawn(harness, `call-${kind}`, { kind });
        const [parentMessage] = (
          (await getConversationWorkState({ conversationId: taskId }))
            ?.messages ?? []
        ).flatMap((input) => readParentMessage(input) ?? []);
        await changeTodos(getSqlExecutor(), {
          change: {
            add: [
              {
                assignee: { conversationId: taskId },
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
        const stopTask = async () => {
          for (const nowMs of [1_800_000_001_000, 1_800_000_002_000]) {
            vi.setSystemTime(nowMs);
            await stopConversation({
              conversationId: taskId,
              conversationStore: harness.conversationStore,
              queue: harness.queue,
              state: harness.state,
            });
          }
        };
        if (when === "waits") {
          await stopTask();
        } else {
          harness.onRun(async (run) => {
            await stopTask();
            return await finishRun(run);
          });
          await harness.drain(taskId);
        }
        expect(harness.runs).toHaveLength(when === "runs" ? 1 : 0);

        // The parent runs the result as the agent that gave the work.
        expect(
          (
            await getConversationWorkState({
              conversationId: slackParentConversationId,
            })
          )?.messages
            .filter((input) => input.input.text.includes('status="stopped"'))
            .map((input) => ({
              authorId: input.input.authorId,
              text: input.input.text,
            })),
        ).toEqual([
          {
            authorId: resultAuthorId(parentMessage!.actor),
            text: expect.stringContaining(`conversation_id="${taskId}"`),
          },
        ]);
        expect(
          (await listTodos(getSqlExecutor(), slackParentConversationId)).map(
            (todo) => todo.status,
          ),
        ).toEqual(["dropped"]);
      } finally {
        await harness.close();
      }
    },
  );

  // A saved Turn of an earlier release can have no Source.
  it.each([{ record: "saved" }, { record: "saved without Source" }] as const)(
    "tells the parent once when a person stops a person's Turn in a Thread ($record)",
    async ({ record }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const threadId = await spawn(harness, "call-person", {
          kind: "thread",
        });
        harness.onRun(finishRun);
        await harness.drain(threadId);
        vi.setSystemTime(1_800_000_001_000);
        await sendPersonMessage(harness, threadId, "person-1");
        harness.onRun(async (run) => {
          // The person's Turn has a saved record with the person's Actor.
          if (record === "saved") {
            await commitRunInput(run);
          } else {
            const { source: _source, ...input } = runInputCheckpoint(run);
            await saveTurnCheckpoint({ ...input, mode: "running" });
            await run.durability?.onInputCommitted?.();
          }
          vi.setSystemTime(1_800_000_002_000);
          await stopConversation({
            conversationId: threadId,
            conversationStore: harness.conversationStore,
            queue: harness.queue,
            state: harness.state,
          });
          return await finishRun(run);
        });
        await harness.drain(threadId);

        expect(harness.runs.at(-1)).toMatchObject({ source: { kind: "web" } });
        // The parent runs the result as the Event system Actor, never as the
        // person.
        expect(
          (
            await getConversationWorkState({
              conversationId: slackParentConversationId,
            })
          )?.messages
            .filter((message) =>
              message.input.text.includes('status="stopped"'),
            )
            .map((message) => ({
              authorId: message.input.authorId,
              text: message.input.text,
            })),
        ).toEqual([
          {
            authorId: resultAuthorId(EVENT_SYSTEM_ACTOR),
            text: expect.stringContaining(`conversation_id="${threadId}"`),
          },
        ]);
      } finally {
        await harness.close();
      }
    },
  );

  it("shows the parent's next Turn that a person stopped a Task", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const taskId = await spawn(harness, "call-report");
      vi.setSystemTime(1_800_000_001_000);
      await stopConversation({
        conversationId: taskId,
        conversationStore: harness.conversationStore,
        queue: harness.queue,
        state: harness.state,
      });

      vi.setSystemTime(1_800_000_061_000);
      harness.onRun(finishRun);
      await harness.processUntilRun(slackParentConversationId);

      const parentRuns = harness.runs.filter(
        (run) => run.conversationId === slackParentConversationId,
      );
      expect(parentRuns).toHaveLength(1);
      expect(parentRuns[0]!.instruction.text).toContain('status="stopped"');
    } finally {
      await harness.close();
    }
  });

  it("tells the parent once that a person stopped a Task when a retry follows a failed report", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const taskId = await spawn(harness, "call-1");
      // The first stop fails when it appends its report to the parent.
      let failed = false;
      const failingParentMailbox = new Proxy(harness.state, {
        get(target, prop) {
          if (prop === "acquireLock") {
            return async (key: string, ttlMs: number) => {
              if (
                !failed &&
                key ===
                  `junior:conversation:v2:mutation:${slackParentConversationId}`
              ) {
                failed = true;
                throw new Error("The parent mailbox is unavailable.");
              }
              return await target.acquireLock(key, ttlMs);
            };
          }
          const value = readProxyProperty(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const stop = (state: StateAdapter) =>
        stopConversation({
          conversationId: taskId,
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state,
        });
      vi.setSystemTime(1_800_000_001_000);
      await expect(stop(failingParentMailbox)).rejects.toThrow(
        "The parent mailbox is unavailable.",
      );
      vi.setSystemTime(1_800_000_002_000);
      await stop(harness.state);

      expect(
        (await mailboxTexts(harness, slackParentConversationId)).filter(
          (text) => text.includes('status="stopped"'),
        ),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("tells the parent once when a worker takes the task between a stop and its redelivery", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const taskId = await spawn(harness, "call-1");
      // The first delivery reports the stop, then fails before it saves it.
      let reported = false;
      let failed = false;
      const failingAfterReport = new Proxy(harness.state, {
        get(target, prop) {
          if (prop === "acquireLock") {
            return async (key: string, ttlMs: number) => {
              if (
                key ===
                `junior:conversation:v2:mutation:${slackParentConversationId}`
              ) {
                reported = true;
              } else if (
                reported &&
                !failed &&
                key === `junior:conversation:v2:mutation:${taskId}`
              ) {
                failed = true;
                throw new Error("The child mailbox is unavailable.");
              }
              return await target.acquireLock(key, ttlMs);
            };
          }
          const value = readProxyProperty(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const stop = (state: StateAdapter) =>
        stopConversation({
          conversationId: taskId,
          conversationStore: harness.conversationStore,
          message: {
            conversationId: taskId,
            createdAtMs: 1_800_000_001_000,
            inboundMessageId: "person-stop",
            source: "web",
          },
          queue: harness.queue,
          state,
        });
      await expect(stop(failingAfterReport)).rejects.toThrow(
        "The child mailbox is unavailable.",
      );
      // A worker takes the waiting task before the stop is redelivered.
      await startConversationWork({
        conversationId: taskId,
        conversationStore: harness.conversationStore,
        state: harness.state,
      });
      await stop(harness.state);

      expect(
        (await mailboxTexts(harness, slackParentConversationId)).filter(
          (text) => text.includes('status="stopped"'),
        ),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
