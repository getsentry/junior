import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  conversationTurnIdForMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  ackMessages,
  appendInboundMessage,
  completeConversationWork,
  ensureConversationWake,
  getConversationWorkState,
  startConversationWork,
  stopConversationWork,
} from "@/chat/task-execution/store";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";
import {
  createConversationWorkHarness,
  inboundMessage,
} from "../fixtures/conversation-work";

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

  it("completes an empty wake on a root that has no Destination", async () => {
    await createConversationFixture();
    const { process, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    const conversationId = "agent-dispatch:no_destination";
    // Work with no Conversation record, so no Destination, whose run saw a
    // stop late.
    const input = inboundMessage("no-destination-input", {
      conversationId,
      destination: undefined,
    });
    await appendInboundMessage({ message: input, state });
    const lease = await startConversationWork({ conversationId, state });
    if (lease.status !== "acquired") throw new Error("Expected work lease");
    await ackMessages({
      conversationId,
      inboundMessageIds: [input.inboundMessageId],
      leaseToken: lease.leaseToken,
      state,
    });
    await stopConversationWork({ conversationId, state });
    await expect(
      completeConversationWork({
        conversationId,
        leaseToken: lease.leaseToken,
        resumeIfStopped: true,
        state,
      }),
    ).resolves.toBe("pending");
    await ensureConversationWake({
      conversationId,
      idempotencyKey: "no-destination-wake",
      queue,
      state,
    });

    // The wake has no input, no open Turn, and no Destination to run.
    await expect(
      process(queue.takeMessageFor(conversationId)),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      getConversationWorkState({ conversationId, state }),
    ).resolves.toMatchObject({ execution: { status: "idle" } });
  });
});
