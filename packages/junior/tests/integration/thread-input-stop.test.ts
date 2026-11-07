import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { getWebAuthorization } from "@/chat/conversations/web-authorization";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { cancelSignInPausedTurn } from "@/chat/task-execution/conversation-turn";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { createEventTools } from "@/chat/tools/events";
import {
  slackDestination,
  loadTurnEvents,
} from "../fixtures/agent-invocations";
import { webTestActor } from "../fixtures/conversation";
import { context, execute } from "../fixtures/event-automations";
import {
  createHarness,
  finishInvocation,
  startThread,
  sendPersonMessage,
  savePersonMessage,
  personPausedPrompt,
  savePersonTurn,
  stopThread,
} from "../fixtures/thread-input";

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
        const personTurnId = await savePersonTurn(threadId, {
          signInPrompt: true,
          withoutMessage,
        });
        const paused = await getTurnRecord(threadId, personTurnId);
        // The stop wake takes queued input before the paused Turn.
        if (queued) await sendPersonMessage(harness, threadId, "person-queued");
        const runCount = harness.runs.length;

        await stopThread(harness, threadId);
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

  it("runs watch Events in a stopped Thread after a person messages it", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const harness = await createHarness();
    try {
      // The stop ends the open Agent invocation before it runs. A person's
      // Message from before the stop does not restart the Thread.
      const threadId = await startThread(harness, "thread-spawn");
      await savePersonMessage(threadId, "api-msg_person-0", clock());
      clock.mockReturnValue(clock() + 1_000);
      await stopThread(harness, threadId);
      await harness.processUntilRun(threadId);
      expect(harness.runs).toHaveLength(0);
      const tools = createEventTools(
        { ...context(), conversationId: threadId },
        getEventCatalog(),
      );
      /** Set a timer on the Thread, fire it, and run its wakes. */
      const fireTimer = async (toolCallId: string) => {
        await execute(
          tools.watchTimer!,
          { after_ms: 60_000, intent: "Check the deploy again." },
          toolCallId,
        );
        clock.mockReturnValue(clock() + 120_000);
        await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
        // The Event batch waits for its burst window.
        clock.mockReturnValue(clock() + 120_000);
        await harness.processUntilRun(threadId);
      };

      // The stopped Thread drops a watch Event that arrives after the stop.
      clock.mockReturnValue(clock() + 1_000);
      await fireTimer("timer-1");
      expect(harness.runs).toHaveLength(0);

      // A person's message restarts it.
      await savePersonMessage(threadId, "api-msg_person-1", clock());
      clock.mockReturnValue(clock() + 1_000);
      await fireTimer("timer-2");
      expect(harness.runs.at(-1)).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        agentInvocationId: expect.any(String),
        conversationId: threadId,
      });
    } finally {
      clock.mockRestore();
      await harness.close();
    }
  });
});
