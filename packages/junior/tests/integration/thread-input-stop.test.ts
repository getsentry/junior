import { afterEach, describe, expect, it } from "vitest";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  getConversationStoppedAtMs,
  markConversationsStopped,
} from "@/chat/conversations/session-stop";
import { getWebAuthorization } from "@/chat/conversations/web-authorization";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { cancelSignInPausedTurn } from "@/chat/task-execution/turn-cancel";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  slackDestination,
  slackParentConversationId,
  loadTurnEvents,
} from "../fixtures/agent-invocations";
import { webTestActor } from "../fixtures/conversation";
import {
  createHarness,
  finishInvocation,
  startThread,
  sendPersonMessage,
  personPausedPrompt,
  savePersonTurn,
} from "../fixtures/thread-input";

/** Stop the Thread from its parent with the stopAgent tool. */
async function stopThread(threadId: string) {
  await expect(
    createStopAgentTool(slackParentConversationId).execute!(
      { conversation_id: threadId },
      {},
    ),
  ).resolves.toMatchObject({ stopped: true });
}

describe("Thread input stop", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it.each([
    { name: "no other input", queued: false, withoutMessage: false },
    { name: "a queued person Message", queued: true, withoutMessage: false },
    { name: "no stored person Message", queued: false, withoutMessage: true },
  ])(
    "ends a person's Turn that waits for sign-in when the tree stops with $name",
    async ({ queued, withoutMessage }) => {
      const harness = await createHarness();
      try {
        const threadId = await startThread(harness, "thread-spawn");
        await harness.process(threadId);
        await finishInvocation(harness, threadId);
        const personTurnId = await savePersonTurn(threadId, "auth", {
          signInPrompt: true,
          withoutMessage,
        });
        const paused = await getTurnRecord(threadId, personTurnId);
        // The stop wake takes queued input before the paused Turn.
        if (queued) await sendPersonMessage(harness, threadId, "person-queued");
        const runCount = harness.runs.length;

        await stopThread(threadId);
        await harness.processUntilRun(threadId);
        expect(harness.runs).toHaveLength(runCount);
        await expect(
          getAuthPausedConversationTurnId(threadId),
        ).resolves.toBeUndefined();
        // The stop cancels the paused Turn like a stopped resume does.
        await expect(loadTurnEvents(threadId)).resolves.toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: "cancelled",
              turnId: personTurnId,
              type: "turn_completed",
            }),
          }),
        );
        const conversation = coerceThreadConversationState(
          await getPersistedThreadState(threadId),
        );
        await hydrateConversationMessages({
          conversation,
          conversationId: threadId,
        });
        expect(conversation.processing.pendingAuth).toBeUndefined();
        expect(
          conversation.messages
            .filter((message) => message.id === "api-msg_person-paused")
            .map(({ meta }) => [meta?.replied, meta?.skippedReason]),
        ).toEqual(withoutMessage ? [] : [[false, "turn cancelled"]]);
        await expect(
          getWebAuthorization({
            actorId: webTestActor.userId,
            conversationId: threadId,
          }),
        ).resolves.toBeUndefined();

        // A sign-in that completes later does not resume the stopped Thread.
        await wakePausedTurn(
          {
            conversationId: threadId,
            destination: slackDestination,
            expectedVersion: paused!.version,
            turnId: personTurnId,
          },
          {
            conversationStore: harness.conversationStore,
            queue: harness.queue,
            state: harness.state,
          },
        );
        await harness.processUntilRun(threadId);
        expect(harness.runs).toHaveLength(runCount);
      } finally {
        await harness.close();
      }
    },
  );

  it("ends a person's Turn in a Thread at its next step after a stored stop", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-step-stop");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      harness.onPersonRun(async (run) => {
        // Only the stored stop is set. No stop request reaches the worker.
        await markConversationsStopped([run.conversationId], {
          cancelWatches: false,
        });
        // The agent loop checks for a stop at each step boundary.
        await run.durability?.checkStop?.();
        run.signal?.throwIfAborted();
        throw new Error("The stored stop did not abort the run");
      });
      await sendPersonMessage(harness, threadId, "person-step-stop");

      await expect(harness.process(threadId)).resolves.toMatchObject({
        status: "completed",
      });
      expect(harness.runs.at(-1)).toMatchObject({
        conversationId: threadId,
        source: { kind: "web" },
      });
      await expect(loadTurnEvents(threadId)).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            turnId: harness.runs.at(-1)!.turnId,
            type: "turn_completed",
          }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps a Turn that a worker resumed after the stop read its sign-in pause", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      const turnId = await savePersonTurn(threadId);
      const paused = (await getTurnRecord(threadId, turnId))!;
      // The worker's first safe boundary lands after the stop read the pause.
      await saveTurnCheckpoint({
        ...paused,
        messages: personPausedPrompt,
        mode: "running",
        sliceId: 2,
      });
      await cancelSignInPausedTurn({ conversationId: threadId, turnId });

      expect(
        (await loadTurnEvents(threadId)).filter(
          ({ data }) =>
            data.type === "turn_completed" && data.turnId === turnId,
        ),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("ends a Thread's stop when a person messages it", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await stopThread(threadId);
      await harness.processUntilRun(threadId);
      expect(harness.runs).toHaveLength(0);

      // As on a root, a person's input runs and ends the stop, so later
      // watch Events and results run again.
      await sendPersonMessage(harness, threadId, "person-1");
      await harness.processUntilRun(threadId);
      expect(harness.runs).toMatchObject([{ actor: webTestActor }]);
      await expect(
        getConversationStoppedAtMs(threadId),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
