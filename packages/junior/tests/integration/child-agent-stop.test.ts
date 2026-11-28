import { afterEach, describe, expect, it, vi } from "vitest";
import { messageChildAgent, spawnChildAgent } from "@/chat/child-agents/create";
import { getAgentReplyMessageId } from "@/chat/child-agents/ids";
import { listChildAgents } from "@/chat/child-agents/list";
import { enqueueStarterUpdate } from "@/chat/child-agents/result";
import type { AgentRun } from "@/chat/agent/types";
import { getConversationStoppedAtMs } from "@/chat/conversations/stop-state";
import { stopConversation } from "@/chat/conversations/stop";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  hasConversationStop,
} from "@/chat/task-execution/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  abortableAgentRunner,
  spawnInput,
  loadTurnEvents,
  parentConversationId,
  prepareParentConversation,
  createPublishChildTurn,
} from "../fixtures/child-agents";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  stoppedConversationMessageTexts,
  storeConversationStop,
} from "../fixtures/conversation";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { finishRun } from "../fixtures/thread-input";

async function stopAgent(
  conversationId: string,
  parent = parentConversationId,
) {
  return await createStopAgentTool(parent).execute!(
    { conversation_id: conversationId },
    {},
  );
}

async function listAgents() {
  return (
    await createListAgentsTool({ conversationId: parentConversationId })
      .execute!({}, {})
  ).agents;
}

/**
 * Compose production conversation work for a local parent. Each test runs
 * child work from the queue, as the queue callback does.
 */
async function createHarness(agentRunner: AgentRunner) {
  const { conversationStore, fixture } = await prepareParentConversation();
  const work = await createConversationWorkHarness(agentRunner);
  const { queue, state } = work;
  return {
    close: async () => await fixture.close(),
    conversationStore,
    /** Deliver a result of a child's Turn to its parent. */
    deliver: createPublishChildTurn({ queue, state }),
    mailbox: async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [],
    /** Give a child a message as the parent's `messageAgent` does. */
    message: async (
      childConversationId: string,
      idempotencyKey: string,
      input: string,
    ) =>
      await messageChildAgent(
        {
          actor: spawnInput.actor,
          childConversationId,
          idempotencyKey,
          input,
          parentConversationId,
          parentToolCallId: idempotencyKey,
          parentTurnId: idempotencyKey,
        },
        { queue, state },
      ),
    process: work.process,
    /** Run the next queued wake of one Conversation. */
    processNext: async (conversationId: string) =>
      await work.process(queue.takeMessageFor(conversationId)),
    queue,
    /** Spawn a child agent as the parent's `startAgent` does. */
    spawn: async (input: {
      agentName?: string;
      idempotencyKey: string;
      input?: string;
      parentConversationId?: string;
    }) =>
      (
        await spawnChildAgent(
          {
            ...spawnInput,
            ...input,
            parentToolCallId: input.idempotencyKey,
            parentTurnId: input.idempotencyKey,
          },
          { conversationStore, queue, state },
        )
      ).childConversationId,
    state,
  };
}

function eventType(message: { input: { metadata?: unknown } }) {
  const metadata = message.input.metadata;
  return isEventMailboxMetadata(metadata) ? metadata.event.eventType : "";
}

describe("stopping child agents", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stops a running child without a result and lets a message start new work", async () => {
    const runner = abortableAgentRunner();
    const harness = await createHarness(runner.agentRunner);
    try {
      const childId = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "stop-running",
        input: "long task",
      });
      const processing = harness.processNext(childId);
      await runner.started();
      const turnId = runner.runs[0]!.turnId;
      // The child replies, and the parent has not read the reply at the stop.
      await harness.deliver({
        actor: spawnInput.actor,
        conversationId: childId,
        update: { status: "done", text: "Old finding." },
        turnId,
      });

      await expect(stopAgent(childId)).resolves.toEqual({
        conversation_id: childId,
        stopped: true,
      });
      const work = await getConversationWorkState({
        conversationId: childId,
        state: harness.state,
      });
      await expect(
        hasConversationStop({
          conversationId: childId,
          runId: work!.execution.runId!,
          state: harness.state,
        }),
      ).resolves.toBe(true);
      // The worker sees the stop request and aborts the run.
      await expect(processing).resolves.toMatchObject({
        status: "completed",
      });

      // The parent asked for the stop, so it gets no result, and the unread
      // reply is dropped.
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      await expect(loadTurnEvents(childId)).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            turnId,
            type: "turn_completed",
          }),
        }),
      );
      await expect(listAgents()).resolves.toEqual([
        expect.objectContaining({
          conversation_id: childId,
          name: "researcher",
          status: "stopped",
        }),
      ]);
      // A repeated stop finds the child already stopped.
      await expect(stopAgent(childId)).resolves.toEqual({
        conversation_id: childId,
        stopped: false,
      });
      // A message from the parent starts new work on the stopped child, in
      // the same parent Turn as the stop.
      await expect(
        harness.message(childId, "after-stop", "short task"),
      ).resolves.toEqual({ delivery: "started" });
      await expect(
        getConversationStoppedAtMs(childId),
      ).resolves.toBeUndefined();
      await expect(listAgents()).resolves.toEqual([
        expect.objectContaining({
          conversation_id: childId,
          status: "running",
        }),
      ]);
      // The new task does not bring back the stopped work's reply.
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("drops a child's unread reply, also one that arrives late, when its parent stops it", async () => {
    const harness = await createHarness({ run: finishRun });
    const quietResult = expect.objectContaining({
      input: expect.objectContaining({
        text: expect.stringMatching(/^<agent-result [^>]*status="done"/),
      }),
    });
    try {
      const childId = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "stop-loop-reply",
        input: "watch deploys",
      });
      await harness.processNext(childId);
      // The task Turn ended the child's work with no answer, so its parent
      // has a result. A later Turn of the child, such as for a Watch Event,
      // replies.
      await harness.deliver({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: childId,
        update: { status: "done", text: "Old finding." },
        turnId: "turn_watch-event",
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([
        quietResult,
        expect.objectContaining({
          inboundMessageId: getAgentReplyMessageId(childId, "turn_watch-event"),
        }),
      ]);

      const beforeStopMs = Date.now();
      await stopAgent(childId);
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      // A reply that the Turn sent before the stop reaches the parent's
      // mailbox after the stop dropped the unread ones.
      const sendLateReply = async () =>
        await enqueueStarterUpdate({
          actor: EVENT_SYSTEM_ACTOR,
          messageKey: "turn_watch-event",
          nowMs: beforeStopMs,
          queue: harness.queue,
          update: { status: "done", text: "Late finding." },
          sender: {
            childConversationId: childId,
            parentConversationId,
          },
          turnId: "turn_watch-event",
          state: harness.state,
        });
      await sendLateReply();
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
      // The parent gives the child a new task in the same Turn.
      await harness.message(childId, "after-loop-stop", "short task");
      await expect(
        getConversationStoppedAtMs(childId),
      ).resolves.toBeUndefined();
      // The stopped Turn's retry sends the dropped reply again.
      await sendLateReply();
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);

      // A person's stop of a child drops its unread reply too.
      const watcherId = await harness.spawn({
        agentName: "builder",
        idempotencyKey: "person-stop-loop-reply",
        input: "watch builds",
      });
      await harness.processNext(watcherId);
      await harness.deliver({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: watcherId,
        update: { status: "done", text: "Build finding." },
        turnId: "turn_build-event",
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([
        quietResult,
        expect.objectContaining({
          inboundMessageId: getAgentReplyMessageId(
            watcherId,
            "turn_build-event",
          ),
        }),
      ]);
      await stopConversation({
        conversationId: watcherId,
        conversationStore: harness.conversationStore,
        queue: harness.queue,
        state: harness.state,
      });
      await expect(harness.mailbox(parentConversationId)).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("ends a running child's Turn at its next step after a stored stop", async () => {
    const harness = await createHarness({
      run: async (run: AgentRun) => {
        // Only the stored stop is set. No stop request reaches the worker.
        await storeConversationStop(run.conversationId);
        // The agent loop checks for a stop at each step boundary.
        await run.durability?.checkStop?.();
        run.signal?.throwIfAborted();
        throw new Error("The stored stop did not abort the run");
      },
    });
    try {
      const childId = await harness.spawn({ idempotencyKey: "stored-stop" });

      await expect(harness.processNext(childId)).resolves.toMatchObject({
        status: "completed",
      });

      await expect(loadTurnEvents(childId)).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            type: "turn_completed",
          }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("never runs a stopped pending child and reports a person's stop to the parent", async () => {
    const runner = abortableAgentRunner();
    const harness = await createHarness(runner.agentRunner);
    try {
      const pendingId = await harness.spawn({
        idempotencyKey: "stop-pending",
        input: "short task",
      });
      await expect(
        stopAgent(pendingId, "local:test:other-parent"),
      ).rejects.toMatchObject({ name: "ToolInputError" });
      await expect(stopAgent(pendingId)).resolves.toEqual({
        conversation_id: pendingId,
        stopped: true,
      });
      // The stop dropped the child's waiting task, so its wake finds no
      // work.
      await expect(harness.processNext(pendingId)).resolves.toMatchObject({
        status: "no_work",
      });
      expect(runner.runs).toEqual([]);

      // A person's stop of the child still reaches the parent, and it also
      // stops the child agents of the child.
      const externalId = await harness.spawn({
        idempotencyKey: "stop-external",
        input: "long task",
      });
      const helperId = await harness.spawn({
        idempotencyKey: "stop-external-helper",
        parentConversationId: externalId,
      });
      const processing = harness.processNext(externalId);
      await runner.started();
      await expect(
        stopConversation({
          conversationId: externalId,
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        }),
      ).resolves.toMatchObject({ status: "requested" });
      await expect(processing).resolves.toMatchObject({
        status: "completed",
      });
      const parentMessages = await harness.mailbox(parentConversationId);
      expect(parentMessages.map(eventType)).toEqual(["agent.update"]);
      expect(parentMessages[0]!.input.text).toMatch(
        /^<agent-result [^>]*status="stopped"/,
      );
      await expect(listChildAgents(externalId)).resolves.toEqual([
        expect.objectContaining({
          childConversationId: helperId,
          status: "stopped",
        }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it("stops every child agent below the child and holds their results", async () => {
    const harness = await createHarness(neverRunAgentRunner());
    try {
      const childId = await harness.spawn({ idempotencyKey: "tree-child" });
      const openHelperId = await harness.spawn({
        idempotencyKey: "tree-open-helper",
        parentConversationId: childId,
      });
      const doneHelperId = await harness.spawn({
        idempotencyKey: "tree-done-helper",
        parentConversationId: childId,
      });
      // A result and a `reply` reach the child mailbox before the stop.
      await harness.deliver({
        actor: spawnInput.actor,
        conversationId: doneHelperId,
        update: { status: "blocked", text: "Helper needs a token." },
        turnId: "turn_done-helper",
      });
      await harness.deliver({
        actor: spawnInput.actor,
        conversationId: openHelperId,
        update: { status: "done", text: "Open helper finding." },
        turnId: "turn_open-helper",
      });
      expect(
        (await harness.mailbox(childId)).map((message) => message.input.text),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Helper needs a token."),
          expect.stringContaining("Open helper finding."),
        ]),
      );

      await expect(stopAgent(childId)).resolves.toEqual({
        conversation_id: childId,
        stopped: true,
      });

      await expect(listChildAgents(childId)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            childConversationId: openHelperId,
            status: "stopped",
          }),
          expect.objectContaining({
            childConversationId: doneHelperId,
            status: "stopped",
          }),
        ]),
      );
      // A late startAgent call of the stopped child starts no work.
      await expect(
        harness.spawn({
          idempotencyKey: "tree-late-helper",
          parentConversationId: childId,
        }),
      ).rejects.toThrow("is stopped, so it cannot give work");
      // The child already had the result and the reply in its mailbox. The
      // stop holds them in one skipped Message, so they start no work.
      await expect(harness.mailbox(childId)).resolves.toEqual([]);
      const [held] = await stoppedConversationMessageTexts(childId);
      expect(held).toContain("Helper needs a token.");
      expect(held).toContain("Open helper finding.");
      await expect(listAgents()).resolves.toEqual([
        expect.objectContaining({
          conversation_id: childId,
          status: "stopped",
        }),
      ]);
    } finally {
      await harness.close();
    }
  });
});
