import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueWebMessage,
  buildWebInboundMessage,
  conversationTurnIdForMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import type { AgentRun } from "@/chat/agent/types";
import { createEventInboundMessage } from "@/chat/events/notification";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

describe("Conversation mailbox Turn after a stopped Turn", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  // JUNIOR-9M: conversation work stopped after repeated failed attempts and
  // left the yielded Turn cursor open. The next Turn could start, but its
  // resume failed with "multiple active mailbox Turns".
  it("supersedes the open Turn cursor when new input starts a Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const first = await createAndEnqueueConversation(
      { actor, idempotencyKey: "stale-turn-1", message: "First request." },
      { conversationStore, queue, state },
    );
    const { conversationId } = first;
    const destination = { platform: "local" as const, conversationId };
    const staleTurnId = conversationTurnIdForMessage(first.messageId);
    await saveTurnCheckpoint({
      mode: "paused",
      conversationId,
      turnId: staleTurnId,
      sliceId: 1,
      reason: "yield",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "First request." }],
          timestamp: Date.now(),
        },
      ],
      destination,
      source: createWebSource(conversationId),
      actor,
      surface: "api",
    });

    const second = await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: "stale-turn-2",
        message: "Second request.",
      },
      { conversationStore, queue, state },
    );
    const worker = createConversationTurnWorker({
      run: async () => {
        throw new Error("Run stops after the Turn starts");
      },
    });
    const context = {
      attempt: {
        ...emptyConversationTurnAttempt({ conversationId, destination }),
        messages: [
          buildWebInboundMessage({
            actor,
            conversationId,
            destination,
            message: "Second request.",
            messageId: second.messageId,
          }),
        ],
      },
      conversationId,
      destination,
      shouldYield: () => false,
      checkIn: async () => true,
    };
    const resolved = await resolveMailboxTurnWork(context);
    if (!resolved) throw new Error("Expected Conversation mailbox work");
    await expect(worker(context, resolved)).rejects.toThrow(
      "Run stops after the Turn starts",
    );

    await expect(
      getTurnRecord(conversationId, staleTurnId),
    ).resolves.toMatchObject({ state: "abandoned" });
    await expect(
      resolveMailboxTurnWork({
        ...context,
        attempt: emptyConversationTurnAttempt({ conversationId, destination }),
      }),
    ).resolves.toBeUndefined();
  });

  // JUNIOR-9M root cause: the last failed attempt marked the Turn failed in
  // the Conversation but left its Turn record running, so the next wake with
  // no new input ran the failed Turn again.
  it("fails the Turn record when the last attempt fails", async () => {
    const { conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = "slack:C9M";
    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C9M",
    };
    await conversationStore.recordActivity({
      conversationId,
      destination,
      nowMs: 1,
      source: "slack",
    });
    const message = createEventInboundMessage({
      event: {
        eventKey: "checks-failed-last-attempt",
        eventType: "pull_request.checks.failed",
        identifier: "getsentry/junior#1563",
        namespace: "github",
        occurredAtMs: 2,
        trustedSummary: "Code change checks failed",
      },
      receivedAtMs: 2,
      subscription: {
        conversationId,
        id: "resource-subscription-last-attempt",
      },
      text: "Code change checks failed",
    });
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message,
      queue,
      state,
    });
    const turnId = conversationTurnIdForMessage(message.inboundMessageId);
    const agentRuns: AgentRun[] = [];
    // The Turn saves a step, then Slack rejects the reply.
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Checks failed on lint." },
        ]);
      }),
      async () => {
        throw new Error("Slack is unavailable");
      },
    );
    const wake = (
      messages: ConversationWorkerContext["attempt"]["messages"],
    ) => ({
      attempt: {
        ...emptyConversationTurnAttempt({ conversationId, destination }),
        isFinalAttempt: true,
        messages,
      },
      checkIn: async () => true,
      conversationId,
      destination,
      shouldYield: () => false,
    });

    const resolved = await resolveMailboxTurnWork(wake([message]));
    if (!resolved) throw new Error("Expected Conversation mailbox work");
    await expect(worker(wake([message]), resolved)).resolves.toEqual({
      status: "completed",
    });

    expect(agentRuns).toHaveLength(1);
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "failed",
    });
    await expect(resolveMailboxTurnWork(wake([]))).resolves.toBeUndefined();
  }, 10_000);
});
