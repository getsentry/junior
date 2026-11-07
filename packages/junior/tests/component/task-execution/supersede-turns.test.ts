import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { supersedeOpenMailboxTurns } from "@/chat/task-execution/supersede-turns";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../fixtures/conversation";

describe("supersedeOpenMailboxTurns", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  // The worker scenario in conversation-stale-turn.test.ts covers the rest.
  // A worker has no seam to stop between two abandon writes, so this calls
  // the function itself.
  it("leaves the remaining Turns open when the Conversation stops", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      { actor, idempotencyKey: "supersede-stop", message: "First request." },
      { conversationStore, queue, state },
    );
    // No harness fault leaves two Turns open, so write their paused
    // checkpoints here. Each extends the committed history.
    const history: Parameters<typeof saveTurnCheckpoint>[0]["messages"] = [];
    for (const turnId of ["turn-yield-1", "turn-yield-2"]) {
      history.push({
        role: "user",
        content: [{ type: "text", text: turnId }],
        timestamp: Date.now(),
      });
      await saveTurnCheckpoint({
        mode: "paused",
        conversationId,
        turnId,
        sliceId: 1,
        reason: "yield",
        messages: [...history],
        destination: { platform: "local", conversationId },
        source: createWebSource(conversationId),
        actor,
        surface: "api",
      });
    }

    let checks = 0;
    await expect(
      supersedeOpenMailboxTurns({
        conversation: coerceThreadConversationState({}),
        conversationId,
        isStopped: () => checks++ > 0,
        keepTurnId: "turn-new",
      }),
    ).resolves.toBe(false);
    const states = await Promise.all(
      ["turn-yield-1", "turn-yield-2"].map(
        async (turnId) => (await getTurnRecord(conversationId, turnId))?.state,
      ),
    );
    expect(states.sort()).toEqual(["abandoned", "paused"]);
  });
});
