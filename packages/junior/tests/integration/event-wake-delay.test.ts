import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventInboundMessage } from "@/chat/events/notification";
import type { AgentRun } from "@/chat/agent/types";
import { getConversationEventStore } from "@/chat/db";
import {
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
    const eventMessage = (sequence: number, receivedAtMs: number) =>
      createEventInboundMessage({
        event: {
          eventKey: `check-${sequence}`,
          eventType: "check_suite.completed",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: receivedAtMs,
          trustedSummary: `Check ${sequence} failed`,
        },
        receivedAtMs,
        subscription,
        text: `Check ${sequence} failed`,
      });

    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(1, baseMs),
      queue,
      state,
    });

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

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(0);
    expect(queue.sentRecords().at(-1)).toMatchObject({ delayMs: 30_000 });

    nowSpy.mockReturnValue(baseMs + 200);
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: eventMessage(2, baseMs + 200),
      queue,
      state,
    });
    expect(queue.sentRecords()).toHaveLength(2);

    nowSpy.mockReturnValue(baseMs + 30_000);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(agentRuns).toHaveLength(0);
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
    expect(agentRuns).toHaveLength(1);

    const userMessages = (
      await getConversationEventStore().loadHistory(conversationId)
    ).flatMap((event) =>
      event.data.type === "message" && event.data.role === "user"
        ? [event.data.text]
        : [],
    );
    expect(userMessages).toEqual(["Check 1 failed\n\nCheck 2 failed"]);
  });
});
