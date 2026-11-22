import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  conversationTurnIdForMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";

describe("Conversation resume wake routing", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("routes an empty resume wake to the active Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "resume-1",
        message: "Resume after yield.",
      },
      { conversationStore, queue, state },
    );
    const turnId = conversationTurnIdForMessage(accepted.messageId);
    const destination = {
      platform: "local" as const,
      conversationId: accepted.conversationId,
    };
    await saveTurnCheckpoint({
      mode: "paused",
      conversationId: accepted.conversationId,
      turnId,
      sliceId: 1,
      reason: "yield",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Resume after yield." }],
          timestamp: Date.now(),
        },
      ],
      destination,
      source: createWebSource(accepted.conversationId),
      actor,
      surface: "api",
    });

    const resolved = await resolveMailboxTurnWork({
      attempt: emptyConversationTurnAttempt({
        conversationId: accepted.conversationId,
        destination,
      }),
      conversationId: accepted.conversationId,
      destination,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toEqual({ kind: "resume", turnId });
  });

  it("does not claim dispatch resume wakes that share surface api", async () => {
    await createConversationFixture();
    const conversationId = "agent-dispatch:dispatch_shared_surface";
    const turnId = "dispatch:dispatch_shared_surface";
    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    await saveTurnCheckpoint({
      mode: "paused",
      conversationId,
      turnId,
      sliceId: 1,
      reason: "yield",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Dispatch resume wake." }],
          timestamp: Date.now(),
        },
      ],
      destination,
      dispatchId: "dispatch_shared_surface",
      surface: "api",
    });

    const resolved = await resolveMailboxTurnWork({
      attempt: emptyConversationTurnAttempt({ conversationId, destination }),
      conversationId,
      destination,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toBeUndefined();
  });
});
