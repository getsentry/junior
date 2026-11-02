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
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";

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
});
