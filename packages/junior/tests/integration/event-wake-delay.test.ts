import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventInboundMessage,
  EVENT_WAIT_MS,
} from "@/chat/events/notification";
import type { AgentRun } from "@/chat/agent/types";
import { renderTaskInput } from "@/chat/task-input";
import { getConversationEventStore } from "@/chat/db";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  recordWebConversationActivity,
} from "@/chat/conversations/web-input";
import {
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../fixtures/conversation";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

function requireConversationTurn(
  worker: (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>,
) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveMailboxTurnWork(context);
    if (!resolved) throw new Error("Expected Conversation mailbox work");
    return await worker(context, resolved);
  };
}

describe("event wake delay", () => {
  afterEach(async () => {
    await closeConversationFixture();
    vi.restoreAllMocks();
  });

  it("waits for a burst of events before running one Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = createConversationId({
      actorEmail: actor.email,
      idempotencyKey: "event-burst-1",
    });
    await recordWebConversationActivity({
      actor,
      conversationId,
      conversationStore,
      nowMs: 1,
    });
    await conversationStore.recordActivity({
      activityAtMs: 1,
      conversationId,
      nowMs: 1,
      title: "Events",
    });

    const baseMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseMs);
    const subscription = {
      conversationId,
      id: "resource-subscription-burst",
    };
    const eventMessage = (sequence: number, receivedAtMs: number) => {
      const task = {
        about: "GitHub PR getsentry/junior#1563",
        instructions: "Fix failed checks on this PR.",
        trustedSummary: `Check ${sequence} failed`,
      };
      return createEventInboundMessage({
        event: {
          eventKey: `check-${sequence}`,
          eventType: "check_suite.completed",
          objectType: "code_change",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: receivedAtMs,
          trustedSummary: `Check ${sequence} failed`,
        },
        receivedAtMs,
        subscription,
        task,
        text: renderTaskInput(task),
      });
    };

    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(1, baseMs),
      queue,
      queueDelayMs: EVENT_WAIT_MS,
      state,
    });
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);

    const agentRuns: AgentRun[] = [];
    const run = requireConversationTurn(
      createConversationTurnWorker(
        createModelAgentRunnerForRun((agentRun) => {
          agentRuns.push(agentRun);
          return createModelStream([
            { type: "text", text: "Handled both events." },
          ]);
        }),
      ),
    );

    nowSpy.mockReturnValue(baseMs + 100);
    await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: "human-message",
        message: "Please check now",
      },
      { conversationStore, queue, state },
    );
    expect(queue.sentRecords()).toHaveLength(2);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(1);

    nowSpy.mockReturnValue(baseMs + 200);
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(2, baseMs + 200),
      queue,
      state,
    });
    expect(queue.sentRecords()).toHaveLength(3);

    nowSpy.mockReturnValue(baseMs + 30_000);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(1);
    expect(queue.sentRecords().at(-1)).toMatchObject({ delayMs: 5_000 });

    nowSpy.mockReturnValue(baseMs + 35_000);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(agentRuns).toHaveLength(2);

    const savedEvents =
      await getConversationEventStore().loadHistory(conversationId);
    // Both Events are listed on the one message, not only the first.
    expect(
      savedEvents.find(
        (event) =>
          event.data.type === "message" &&
          event.data.meta?.eventType === "check_suite.completed",
      )?.data,
    ).toMatchObject({
      meta: {
        eventObjectType: "code_change",
        events: [
          {
            eventType: "check_suite.completed",
            label: "GitHub PR getsentry/junior#1563",
            trustedSummary: "Check 1 failed",
          },
          {
            eventType: "check_suite.completed",
            label: "GitHub PR getsentry/junior#1563",
            trustedSummary: "Check 2 failed",
          },
        ],
      },
    });
    const userMessages = savedEvents.flatMap((event) =>
      event.data.type === "message" && event.data.role === "user"
        ? [event.data.text]
        : [],
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toBe("Please check now");
    // One task message states the instructions once for both Events.
    const batchText = userMessages[1]!;
    expect(batchText).toContain("You received 2 events.");
    expect(batchText.match(/Instructions: /g)).toHaveLength(1);
    expect(batchText).toContain(
      "Event 1: check_suite.completed\nTrusted summary: Check 1 failed",
    );
    expect(batchText).toContain(
      "Event 2: check_suite.completed\nTrusted summary: Check 2 failed",
    );
  });
});
