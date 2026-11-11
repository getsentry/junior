import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS, getChatConfig } from "@/chat/config";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import {
  getAgentInvocationTurnId,
  getAgentReplyMessageId,
} from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import {
  createDeliverToParent,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  buildAgentInvocationInboundMessage,
  createAndEnqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  type TurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import {
  createConversationWorkHarness,
  runHeartbeatAfterLeasesExpire,
} from "../fixtures/conversation-work";

/**
 * Integration tests do not run the agent. This runner reads each run and the
 * Turn saved for it, then stops the run.
 */
function readingAgentRunner() {
  const runs: Array<{ run: AgentRun; turn?: TurnRecord }> = [];
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

describe("agent invocation worker crash", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("tells the parent when every try of a child worker is killed", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    // Every try is killed before the agent can run.
    const { killWorker, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    try {
      const created = await createAndEnqueueAgentInvocation(
        { ...invocationInput, idempotencyKey: "crash-1" },
        { conversationStore, queue, state },
      );
      const { childConversationId, invocationId } = created;

      let followUpId = "";
      let unappendedId = "";
      for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
        // Injected fault: the worker of this try is killed mid-run.
        await killWorker(queue.takeMessageFor(childConversationId));
        if (tries === CONVERSATION_WORK_MAX_RETRIES) {
          // The parent gives the dying child more work. Stopped work drops
          // its mailbox, so this task never runs either.
          const { invocation } = await createAgentInvocationForMessage({
            actor: invocationInput.actor,
            childConversationId,
            destination: invocationInput.destination,
            idempotencyKey: "crash-follow-up",
            input: "Also check the retry path.",
            parentConversationId,
            parentToolCallId: "call-message",
          });
          // Injected fault: the enqueue dies after its mailbox write, before
          // it marks the invocation appended. No harness fault stops it there.
          await appendAndEnqueueInboundMessage({
            conversationStore,
            message: buildAgentInvocationInboundMessage(invocation),
            queue,
            state,
          });
          followUpId = invocation.invocationId;
          // A task whose append has not run yet starts new work instead.
          const { invocation: unappended } =
            await createAgentInvocationForMessage({
              actor: invocationInput.actor,
              childConversationId,
              destination: invocationInput.destination,
              idempotencyKey: "crash-unappended",
              input: "Then check the docs.",
              parentConversationId,
              parentToolCallId: "call-message-2",
            });
          unappendedId = unappended.invocationId;
        }
        await runHeartbeatAfterLeasesExpire(queue);
      }

      const child = await getConversationWorkState({
        conversationId: childConversationId,
      });
      expect(child?.execution.pendingMessages).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            metadata: expect.objectContaining({
              agentInvocationId: unappendedId,
            }),
          }),
        }),
      ]);
      await expect(getAgentInvocation(unappendedId)).resolves.toMatchObject({
        mailboxStatus: "appended",
        status: "pending",
      });
      for (const id of [invocationId, followUpId]) {
        await expect(getAgentInvocation(id)).resolves.toMatchObject({
          parentMailboxStatus: "appended",
          status: "failed",
        });
      }
      const parent = await getConversationWorkState({
        conversationId: parentConversationId,
      });
      const stopped = expect.stringMatching(
        /stopped because its worker failed repeatedly/,
      );
      expect(parent?.messages.map((message) => message.input.text)).toEqual([
        stopped,
        stopped,
      ]);
      // Nothing may resume the dead Turn.
      await expect(
        getTurnRecord(
          childConversationId,
          getAgentInvocationTurnId(invocationId),
        ),
      ).resolves.not.toMatchObject({
        state: expect.stringMatching(/running|paused/),
      });
    } finally {
      await fixture.close();
    }
  });

  // A child Turn on the Conversation loop has no agent invocation to fail.
  // When every try is killed, a Task's parent learns it, and a Thread keeps
  // the stored failure. A Task that already replied sent its answer.
  it.each([
    { kind: "task" as const, notices: 1, replied: false },
    { kind: "task" as const, notices: 0, replied: true },
    { kind: "thread" as const, notices: 0, replied: false },
  ])(
    "tells only a Task's parent when every try of its Conversation loop Turn is killed ($kind, replied: $replied)",
    async ({ kind, notices, replied }) => {
      vi.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ["Date", "setInterval", "clearInterval"],
      });
      const { conversationStore, fixture } = await prepareParentConversation();
      const { killWorker, queue, state } = await createConversationWorkHarness(
        neverRunAgentRunner(),
      );
      try {
        const child = await createAgentInvocation({
          ...invocationInput,
          idempotencyKey: `loop-crash-${kind}`,
          kind,
        });
        await completeAgentInvocation({
          invocationId: child.invocationId,
          result: "Watching.",
          status: "completed",
        });
        const helper = await createAgentInvocation({
          ...invocationInput,
          idempotencyKey: `loop-crash-helper-${kind}`,
          parentConversationId: child.childConversationId,
        });
        // The helper's `reply` wakes the child on the Conversation loop.
        await enqueueChildResultToParent({
          messageKey: "helper-reply",
          queue,
          result: {
            kind: "reply",
            reply: { text: "Helper fact.", toolCallId: "helper-reply" },
          },
          sender: helper,
          state,
        });
        vi.setSystemTime(Date.now() + 60_000);
        if (replied) {
          // The Turn sent its `reply`, and then its worker was lost.
          await createDeliverToParent({ queue, state })({
            actor: EVENT_SYSTEM_ACTOR,
            conversationId: child.childConversationId,
            result: {
              kind: "reply",
              reply: { text: "Answer.", toolCallId: "call-answer" },
            },
            turnId: buildDeterministicTurnId(
              getAgentReplyMessageId(helper.invocationId, "helper-reply"),
            ),
          });
        }
        for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
          // Injected fault: the worker of this try is killed mid-run.
          await killWorker(queue.takeMessageFor(child.childConversationId));
          await runHeartbeatAfterLeasesExpire(queue);
        }

        const parent = await getConversationWorkState({
          conversationId: parentConversationId,
        });
        expect(
          parent?.messages
            .map((message) => message.input.text)
            .filter((text) => text.includes("worker failed repeatedly")),
        ).toEqual(
          Array.from({ length: notices }, () =>
            expect.stringMatching(/status="failed"/),
          ),
        );
        await expect(
          conversationStore.get({ conversationId: child.childConversationId }),
        ).resolves.toMatchObject({ execution: { status: "failed" } });
      } finally {
        await fixture.close();
      }
    },
  );

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
      const { childConversationId, invocationId } =
        await createAndEnqueueAgentInvocation(
          { ...invocationInput, idempotencyKey: "lost-worker-1" },
          { conversationStore, queue, state },
        );
      // Injected fault: the worker is killed after its run saved its input,
      // as at the end of its host request.
      await killWorker(queue.takeMessageFor(childConversationId), {
        afterInputSaved: true,
      });
      await runHeartbeatAfterLeasesExpire(queue);
      await process(queue.takeMessageFor(childConversationId));

      // The next run continues the same Turn from the saved input.
      expect(runner.runs.map(({ turn }) => turn)).toEqual([
        expect.objectContaining({
          lostWorkerResumeCount: 1,
          piMessages: [
            expect.objectContaining({
              content: [
                {
                  text: expect.stringContaining(invocationInput.input),
                  type: "text",
                },
              ],
              role: "user",
            }),
          ],
          resumeReason: "retry",
          state: "paused",
        }),
      ]);
      await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
        status: "running",
      });
    } finally {
      await fixture.close();
    }
  });

  it("stops a resumed child whose worker is killed before it saves", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    const { killWorker, process, queue, state } =
      await createConversationWorkHarness(neverRunAgentRunner());
    try {
      const { childConversationId, invocationId } =
        await createAndEnqueueAgentInvocation(
          { ...invocationInput, idempotencyKey: "lost-worker-2" },
          { conversationStore, queue, state },
        );
      // Injected fault: the first worker is killed after its run saved its
      // input. The worker of the resumed run is killed before it saves.
      await killWorker(queue.takeMessageFor(childConversationId), {
        afterInputSaved: true,
      });
      await runHeartbeatAfterLeasesExpire(queue);
      await killWorker(queue.takeMessageFor(childConversationId));
      await runHeartbeatAfterLeasesExpire(queue);

      await expect(
        process(queue.takeMessageFor(childConversationId)),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
        errorMessage: "Agent invocation lost its worker before it could pause",
        parentMailboxStatus: "appended",
        status: "failed",
      });
      const parent = await getConversationWorkState({
        conversationId: parentConversationId,
      });
      expect(parent?.messages.map((message) => message.input.text)).toEqual([
        expect.stringMatching(/status="failed"[\s\S]*lost its worker/),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("gives a child run the deadline of its worker's host request", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const runner = readingAgentRunner();
    const { process, queue, state } = await createConversationWorkHarness(
      runner.agentRunner,
    );
    try {
      const { childConversationId } = await createAndEnqueueAgentInvocation(
        { ...invocationInput, idempotencyKey: "host-deadline-1" },
        { conversationStore, queue, state },
      );
      // The request started before this worker took the child. The run
      // pauses at the request deadline, not a full Turn timeout later.
      const requestStartedAtMs = Date.now() - 60_000;
      const message = queue.takeMessageFor(childConversationId);
      await runWithTurnRequestDeadline(
        () => process(message),
        requestStartedAtMs,
      );

      expect(runner.runs.map(({ run }) => run.deadlineAtMs)).toEqual([
        requestStartedAtMs +
          (getChatConfig().functionMaxDurationSeconds -
            FUNCTION_TIMEOUT_BUFFER_SECONDS) *
            1000,
      ]);
    } finally {
      await fixture.close();
    }
  });
});
