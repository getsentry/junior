import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSteeringPiMessage } from "@/chat/agent/prompt";
import { loadConversationProjection } from "@/chat/conversations/projection";
import {
  inboundMessageActor,
  inboundMessageProvenance,
  saveSteeringMessages,
} from "@/chat/providers/slack/input";
import type { QueuedTurnMessage } from "@/chat/runtime/turn-input";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { createTestMessage } from "../../../fixtures/slack-harness";

const TEAM_ID = "T123";

/** A mention as the mailbox gives it to the Slack turn. */
function queuedMention(args: {
  conversationId: string;
  id: string;
  text: string;
  userId?: string;
}): QueuedTurnMessage {
  return {
    explicitMention: true,
    message: createTestMessage({
      id: args.id,
      threadId: args.conversationId,
      text: args.text,
      isMention: true,
      author: args.userId ? { userId: args.userId } : undefined,
    }),
    rawText: args.text,
    userText: args.text,
  };
}

/** The agent input that the Slack turn saves for one mention. */
function steering(queued: QueuedTurnMessage) {
  const provenance = inboundMessageProvenance(queued, TEAM_ID);
  return {
    message: buildSteeringPiMessage({
      actor: inboundMessageActor(queued),
      provenance,
      text: queued.userText,
      timestampMs: queued.message.metadata.dateSent.getTime(),
    }),
    provenance,
  };
}

/** Saved agent input with the provenance of each message. */
async function savedInput(conversationId: string) {
  const projection = await loadConversationProjection({ conversationId });
  return projection.messages.map((message, index) => ({
    text: JSON.stringify(message),
    provenance: projection.provenance[index],
  }));
}

describe("saveSteeringMessages", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("saves a redelivered message one time and adds only the new message of a batch", async () => {
    const conversationId = "slack:C0STEERONCE:1700000000.000";
    const first = steering(
      queuedMention({ conversationId, id: "m-1", text: "first follow-up" }),
    );
    const second = steering(
      queuedMention({ conversationId, id: "m-2", text: "second follow-up" }),
    );

    await expect(
      saveSteeringMessages({ conversationId, messages: [first] }),
    ).resolves.toBe(true);
    await expect(
      saveSteeringMessages({ conversationId, messages: [first] }),
    ).resolves.toBe(true);
    // A repeated mailbox delivery has the saved message and a new one.
    await expect(
      saveSteeringMessages({ conversationId, messages: [first, second] }),
    ).resolves.toBe(true);

    const saved = await savedInput(conversationId);
    expect(saved).toHaveLength(2);
    expect(saved[0]!.text).toContain("first follow-up");
    expect(saved[1]!.text).toContain("second follow-up");
  });

  it("keeps the author of each message as its instruction actor", async () => {
    const conversationId = "slack:C0STEERAUTHOR:1700000000.000";

    await saveSteeringMessages({
      conversationId,
      messages: [
        steering(
          queuedMention({
            conversationId,
            id: "m-alice",
            text: "alice question",
            userId: "U-alice",
          }),
        ),
        steering(
          queuedMention({
            conversationId,
            id: "m-bob",
            text: "bob question",
            userId: "U-bob",
          }),
        ),
      ],
    });

    const saved = await savedInput(conversationId);
    expect(
      saved.find((entry) => entry.text.includes("alice question"))?.provenance,
    ).toMatchObject({
      authority: "instruction",
      actor: { platform: "slack", teamId: TEAM_ID, userId: "U-alice" },
    });
    expect(
      saved.find((entry) => entry.text.includes("bob question"))?.provenance,
    ).toMatchObject({
      authority: "instruction",
      actor: { platform: "slack", teamId: TEAM_ID, userId: "U-bob" },
    });
  });

  it("saves nothing while a resumed Run holds the Conversation lock", async () => {
    const conversationId = "slack:C0STEERLOCK:1700000000.000";
    const state = getStateAdapter();
    await state.connect();
    const lock = await acquireActiveLock(state, conversationId);
    if (!lock) throw new Error("Expected the Conversation lock");

    try {
      await expect(
        saveSteeringMessages({
          conversationId,
          messages: [
            steering(
              queuedMention({
                conversationId,
                id: "m-locked",
                text: "also check the logs",
              }),
            ),
          ],
        }),
      ).resolves.toBe(false);
    } finally {
      await state.releaseLock(lock);
    }

    expect(await savedInput(conversationId)).toEqual([]);
  });
});
