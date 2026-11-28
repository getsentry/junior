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
import { getSpaceLead } from "@/chat/lead/conversation";
import { setConversationSpace } from "@/chat/spaces/conversations";
import { createSpace } from "@/chat/spaces/store";
import type { StateAdapter } from "chat";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";
import {
  createConversationWorkHarness,
  inboundMessage,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { signedInViewer } from "../fixtures/user";

/**
 * Consume the pending input of `conversationId`, then leave the wake that a
 * run which saw its stop late leaves: no input and no open Turn.
 */
async function leaveEmptyWake(
  conversationId: string,
  queue: ConversationWorkQueueTestAdapter,
  state: StateAdapter,
): Promise<void> {
  const work = await getConversationWorkState({ conversationId, state });
  const lease = await startConversationWork({ conversationId, state });
  if (lease.status !== "acquired") throw new Error("Expected work lease");
  await ackMessages({
    conversationId,
    inboundMessageIds: work!.messages.map(
      (message) => message.inboundMessageId,
    ),
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
    idempotencyKey: `${conversationId}:empty-wake`,
    queue,
    state,
  });
}

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
    // Work with no Conversation record, so no Destination.
    const input = inboundMessage("no-destination-input", {
      conversationId,
      destination: undefined,
    });
    await appendInboundMessage({ message: input, state });
    await leaveEmptyWake(conversationId, queue, state);

    // The wake has no input, no open Turn, and no Destination to run.
    await expect(
      process(queue.takeMessageFor(conversationId)),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      getConversationWorkState({ conversationId, state }),
    ).resolves.toMatchObject({ execution: { status: "idle" } });
  });

  it("completes an empty wake on a web root and on a child that kept its root's Destination", async () => {
    const { actor } = await createConversationFixture();
    const { process, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    const space = await createSpace({
      creator: await signedInViewer(actor.email),
      description: null,
      name: "Deploys",
      visibility: "public",
    });
    const lead = await getSpaceLead(space.id);
    // The work of a web root stores its local Destination.
    const [root, child] = await Promise.all(
      ["empty-wake-root", "empty-wake-child"].map(
        async (idempotencyKey) =>
          (
            await createAndEnqueueConversation(
              {
                actor,
                idempotencyKey,
                message: "Check the deploy.",
                visibility: "public",
              },
              { queue, state },
            )
          ).conversationId,
      ),
    );
    // In a Space it is a child of the Lead, and its work keeps that
    // Destination.
    await setConversationSpace(
      child!,
      { leadConversationId: lead.conversationId, spaceId: space.id },
      null,
    );

    for (const conversationId of [root!, child!]) {
      await expect(
        getConversationWorkState({ conversationId, state }),
      ).resolves.toMatchObject({ destination: { platform: "local" } });
      await leaveEmptyWake(conversationId, queue, state);
      await expect(
        process(queue.takeMessageFor(conversationId)),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        getConversationWorkState({ conversationId, state }),
      ).resolves.toMatchObject({ execution: { status: "idle" } });
    }
  });
});
