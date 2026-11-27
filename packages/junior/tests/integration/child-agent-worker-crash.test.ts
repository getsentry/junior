import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { AgentRun } from "@/chat/agent/types";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { spawnChildAgent } from "@/chat/child-agents/create";
import {
  getAgentReplyMessageId,
  getParentMessageId,
} from "@/chat/child-agents/ids";
import { listChildAgents } from "@/chat/child-agents/list";
import { bindSpawnAgent } from "@/chat/child-agents/spawn";
import { enqueueStarterUpdate } from "@/chat/child-agents/result";
import { appendAndEnqueueWebMessage } from "@/chat/conversations/web-input";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  dropPendingMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  type TurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  destination,
  spawnInput,
  loadSubagentEvents,
  parentConversationId,
  prepareParentConversation,
  createPublishChildTurn,
} from "../fixtures/child-agents";
import {
  createConversationWorkHarness,
  runHeartbeatAfterLeasesExpire,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { webTestActor } from "../fixtures/conversation";
import { finishRun } from "../fixtures/thread-input";
import type { ConversationStore } from "@/chat/conversations/store";
import type { StateAdapter } from "chat";

/**
 * Integration tests do not run the agent. This runner reads each run and the
 * Turn saved for it, then stops the run.
 */
function readingAgentRunner() {
  const runs: Array<{ run: AgentRun; turn?: TurnRecord | undefined }> = [];
  const agentRunner: AgentRunner = {
    run: async (run) => {
      runs.push({
        run,
        turn: await getTurnRecord(run.conversationId, run.turnId),
      });
      throw new Error("stop after reading the run");
    },
  };
  return { agentRunner, runs };
}

/** Spawn one child agent of a parent, as `startAgent` does. */
async function spawnChild(
  options: {
    conversationStore: ConversationStore;
    queue: ConversationWorkQueueTestAdapter;
    state: StateAdapter;
  },
  idempotencyKey: string,
  input: { kind?: "task" | "thread"; parentConversationId?: string } = {},
) {
  return (
    await spawnChildAgent(
      {
        ...spawnInput,
        idempotencyKey,
        parentToolCallId: idempotencyKey,
        parentTurnId: "parent-turn",
        ...input,
      },
      options,
    )
  ).childConversationId;
}

async function parentMessageTexts() {
  return (
    (
      await getConversationWorkState({
        conversationId: parentConversationId,
      })
    )?.messages.map((message) => message.input.text) ?? []
  );
}

describe("child agent worker crash", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  // When every try of a child Turn is killed, its parent learns it, whoever
  // started the Turn. A child whose lost Turn already replied sent its answer. A reply of an earlier Turn does not
  // answer the lost one.
  it.each([
    { kind: "task" as const, notices: 1, replied: "no" },
    { kind: "task" as const, notices: 0, replied: "this Turn" },
    { kind: "task" as const, notices: 1, replied: "an earlier Turn" },
    { kind: "thread" as const, notices: 1, replied: "no" },
    { kind: "thread" as const, notices: 1, replied: "no", person: true },
  ])(
    "tells a child's parent when every try of its Conversation loop Turn is killed ($kind, replied: $replied, person: $person)",
    async ({ kind, notices, person, replied }) => {
      vi.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      const { conversationStore, fixture } = await prepareParentConversation();
      // The child's first task ends without a `reply`. Later tries are
      // killed before the agent runs.
      const { killWorker, process, queue, state } =
        await createConversationWorkHarness({ run: finishRun });
      try {
        const options = { conversationStore, queue, state };
        const childId = await spawnChild(options, `loop-crash-${kind}`, {
          kind,
        });
        await process(queue.takeMessageFor(childId));
        const helperId = await spawnChild(
          options,
          `loop-crash-helper-${kind}`,
          { parentConversationId: childId },
        );
        if (person) {
          // A person's Message wakes the Thread instead.
          await appendAndEnqueueWebMessage(
            {
              actor: webTestActor,
              conversationId: childId,
              idempotencyKey: "person-1",
              message: "What did you find?",
            },
            options,
          );
        } else {
          // The helper's `reply` wakes the child on the Conversation loop.
          await enqueueStarterUpdate({
            actor: spawnInput.actor,
            messageKey: "helper-reply",
            queue,
            update: { status: "done", text: "Helper fact." },
            sender: {
              childConversationId: helperId,
              parentConversationId: childId,
            },
            turnId: "turn_helper",
            state,
          });
        }
        vi.setSystemTime(Date.now() + 60_000);
        if (replied === "an earlier Turn") {
          // An earlier Turn read its input and replied.
          const earlier = getAgentReplyMessageId(helperId, "earlier-reply");
          await appendInboundMessage({
            message: {
              conversationId: childId,
              createdAtMs: Date.now() - 1,
              delivery: "defer",
              inboundMessageId: earlier,
              input: { text: "Earlier fact." },
              receivedAtMs: Date.now() - 1,
              source: "event",
            },
            state,
          });
          await dropPendingMessages({
            conversationId: childId,
            inboundMessageIds: [earlier],
            state,
          });
          await createPublishChildTurn({ queue, state })({
            actor: EVENT_SYSTEM_ACTOR,
            conversationId: childId,
            update: { status: "done", text: "Earlier answer." },
            turnId: buildDeterministicTurnId(earlier),
          });
        }
        if (replied === "this Turn") {
          // The Turn sent its `reply`, and then its worker was lost.
          await createPublishChildTurn({ queue, state })({
            actor: EVENT_SYSTEM_ACTOR,
            conversationId: childId,
            update: { status: "done", text: "Answer." },
            turnId: buildDeterministicTurnId(
              getAgentReplyMessageId(helperId, "helper-reply"),
            ),
          });
        }
        for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
          // Injected fault: the worker of this try is killed mid-run.
          await killWorker(queue.takeMessageFor(childId));
          await runHeartbeatAfterLeasesExpire(queue);
        }

        expect(
          (await parentMessageTexts()).filter((text) =>
            text.includes("worker failed repeatedly"),
          ),
        ).toEqual(
          Array.from({ length: notices }, () =>
            expect.stringMatching(/status="failed"/),
          ),
        );
        await expect(
          conversationStore.get({ conversationId: childId }),
        ).resolves.toMatchObject({ execution: { status: "failed" } });
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["task", "thread"] as const)(
    "tells a %s's parent when every try of its spawned task is killed",
    async (kind) => {
      vi.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      const { conversationStore, fixture } = await prepareParentConversation();
      const { killWorker, queue, state } = await createConversationWorkHarness(
        neverRunAgentRunner(),
      );
      try {
        const { childConversationId } = await bindSpawnAgent(
          {
            actor: { platform: "local", userId: "local-user" },
            conversationId: parentConversationId,
            destination,
            instruction: { text: "Delegate the investigation." },
            source: createLocalSource(parentConversationId),
            turnId: "parent-turn",
          },
          { conversationStore, queue, state },
        )!({ kind, task: "Check the deploy." }, { toolCallId: "call-1" });
        for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
          // Injected fault: the worker of this try is killed mid-run.
          await killWorker(queue.takeMessageFor(childConversationId));
          await runHeartbeatAfterLeasesExpire(queue);
        }

        expect(
          (await parentMessageTexts()).filter((text) =>
            text.includes("worker failed repeatedly"),
          ),
        ).toEqual([expect.stringMatching(/status="failed"/)]);
        await expect(
          conversationStore.get({ conversationId: childConversationId }),
        ).resolves.toMatchObject({ execution: { status: "failed" } });
        // No Turn ended, so the failed work alone makes the child fail.
        const [listed] = await listChildAgents(parentConversationId);
        expect(listed).toMatchObject({ status: "failed" });
        expect(listed).not.toHaveProperty("lastResult");
      } finally {
        await fixture.close();
      }
    },
  );

  it("ends a Task's marker of its Thread when every try of the Thread is killed", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    const { killWorker, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    try {
      const taskId = await spawnChild(
        { conversationStore, queue, state },
        "task",
      );
      const { childConversationId: threadId } = await bindSpawnAgent(
        {
          actor: { platform: "local", userId: "local-user" },
          conversationId: taskId,
          destination,
          instruction: { text: "Delegate the investigation." },
          source: createLocalSource(taskId),
          turnId: "task-turn",
        },
        { conversationStore, maxAgentDepth: 2, queue, state },
      )!(
        { kind: "thread", task: "Check the deploy." },
        { toolCallId: "call-1" },
      );
      for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
        // Injected fault: the worker of this try is killed mid-run.
        await killWorker(queue.takeMessageFor(threadId));
        await runHeartbeatAfterLeasesExpire(queue);
      }

      await expect(loadSubagentEvents(taskId)).resolves.toContainEqual({
        type: "subagent_ended",
        subagentInvocationId: getParentMessageId(taskId, "task-turn:call-1"),
        outcome: "error",
      });
    } finally {
      await fixture.close();
    }
  });

  it("resumes a killed child from its last save", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    const runner = readingAgentRunner();
    const { killWorker, process, queue, state } =
      await createConversationWorkHarness(runner.agentRunner);
    try {
      const childId = await spawnChild(
        { conversationStore, queue, state },
        "lost-worker-1",
      );
      // Injected fault: the worker is killed after its run saved its input,
      // as at the end of its host request.
      await killWorker(queue.takeMessageFor(childId), {
        afterInputSaved: true,
      });
      const [killedTurnId] = (await listTurnSummaries(childId)).map(
        (turn) => turn.turnId,
      );
      await runHeartbeatAfterLeasesExpire(queue);
      await process(queue.takeMessageFor(childId));

      // The next run continues the same Turn from the saved input.
      expect(runner.runs).toEqual([
        {
          run: expect.objectContaining({ turnId: killedTurnId }),
          turn: expect.objectContaining({
            piMessages: [
              expect.objectContaining({
                content: [
                  {
                    text: expect.stringContaining(spawnInput.input),
                    type: "text",
                  },
                ],
                role: "user",
              }),
            ],
            turnId: killedTurnId,
          }),
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  // The host kills a request at its deadline. A child's agent run must stop
  // first, so it pauses instead of losing its worker.
  it("ends a child's agent run when its host request ends", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const runner = readingAgentRunner();
    const { processNearRequestDeadline, queue, state } =
      await createConversationWorkHarness(runner.agentRunner);
    try {
      const childId = await spawnChild(
        { conversationStore, queue, state },
        "near-deadline",
      );
      // Injected fault: the host request has 2.5s left.
      const { requestDeadlineAtMs } = await processNearRequestDeadline(
        queue.takeMessageFor(childId),
        2_500,
      );

      expect(runner.runs.map(({ run }) => run.deadlineAtMs)).toEqual([
        requestDeadlineAtMs,
      ]);
    } finally {
      await fixture.close();
    }
  });
});
