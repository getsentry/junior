import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueWebMessage,
  buildWebInboundMessage,
  conversationTurnIdForMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import {
  createWebAuthorization,
  getWebAuthorization,
} from "@/chat/conversations/web-authorization";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
  requireConversationTurn,
} from "../fixtures/conversation";

describe("Conversation mailbox Turn after a stopped Turn", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  // JUNIOR-9M: conversation work stopped after repeated failed attempts and
  // left the yielded Turn cursor open. The next Turn could start, but its
  // resume failed with "multiple active mailbox Turns".
  it("supersedes every other open Turn and its sign-in when new input starts a Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const first = await createAndEnqueueConversation(
      { actor, idempotencyKey: "stale-turn-1", message: "First request." },
      { conversationStore, queue, state },
    );
    const { conversationId } = first;
    const destination = { platform: "local" as const, conversationId };
    const second = await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: "stale-turn-2",
        message: "Second request.",
      },
      { conversationStore, queue, state },
    );
    const staleTurnId = conversationTurnIdForMessage(first.messageId);
    const keptTurnId = conversationTurnIdForMessage(second.messageId);

    // No harness fault leaves several Turns open: a stopped worker, an
    // abandoned sign-in and a lost retry of the same input each leave one.
    // Write their paused checkpoints here. Each extends the committed history.
    const history: Parameters<typeof saveTurnCheckpoint>[0]["messages"] = [];
    const pause = async (turnId: string, reason: "auth" | "yield") => {
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
        reason,
        messages: [...history],
        destination,
        source: createWebSource(conversationId),
        actor,
        surface: "api",
      });
    };
    await pause(staleTurnId, "yield");
    await pause("turn-auth", "auth");
    // An earlier try of the second input saved its Turn, then lost its worker.
    await pause(keptTurnId, "yield");
    const conversation = coerceThreadConversationState(
      await getPersistedThreadState(conversationId),
    );
    conversation.processing.pendingAuth = {
      actorId: actor.userId,
      kind: "plugin",
      linkSentAtMs: Date.now(),
      provider: "github",
      sessionId: "turn-auth",
    };
    await persistThreadStateById(conversationId, { conversation });
    await createWebAuthorization({
      actorId: actor.userId,
      conversationId,
    }).deliver({
      authorizationUrl: "https://example.com/oauth",
      completionText: "Connected.",
      label: "GitHub",
    });

    const worker = requireConversationTurn(
      createConversationTurnWorker({
        run: async () => {
          throw new Error("Run stops after the Turn starts");
        },
      }),
    );
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
    await expect(worker(context)).rejects.toThrow(
      "Run stops after the Turn starts",
    );

    await expect(
      Promise.all(
        [staleTurnId, "turn-auth", keptTurnId].map(
          async (turnId) =>
            (await getTurnRecord(conversationId, turnId))?.state,
        ),
      ),
    ).resolves.toEqual(["abandoned", "abandoned", "paused"]);
    // The superseded Turns are closed, and the dashboard sign-in prompt is gone.
    expect(
      coerceThreadConversationState(
        await getPersistedThreadState(conversationId),
      ).processing.lastCompletedAtMs,
    ).toBeDefined();
    await expect(
      getWebAuthorization({ actorId: actor.userId, conversationId }),
    ).resolves.toBeUndefined();
    // Only the Turn of the new input stays open, so the next wake resumes it.
    await expect(
      resolveMailboxTurnWork({
        ...context,
        attempt: emptyConversationTurnAttempt({ conversationId, destination }),
      }),
    ).resolves.toEqual({ kind: "resume", turnId: keptTurnId });
  });
});
