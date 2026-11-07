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
import { supersedeOpenMailboxTurns } from "@/chat/task-execution/supersede-turns";
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

  it("ends every other open Turn and its sign-in, unless the Conversation stops", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      { actor, idempotencyKey: "supersede-1", message: "First request." },
      { conversationStore, queue, state },
    );
    const destination = { platform: "local" as const, conversationId };
    // Each checkpoint extends the committed Conversation history.
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
    const states = async (turnIds: string[]) =>
      await Promise.all(
        turnIds.map(
          async (turnId) =>
            (await getTurnRecord(conversationId, turnId))?.state,
        ),
      );
    await pause("turn-kept", "yield");
    await pause("turn-yield-1", "yield");
    await pause("turn-yield-2", "yield");
    const conversation = coerceThreadConversationState({});

    // A stop after the first abandon leaves the rest open.
    let checks = 0;
    await expect(
      supersedeOpenMailboxTurns({
        conversation,
        conversationId,
        isStopped: () => checks++ > 0,
        keepTurnId: "turn-kept",
      }),
    ).resolves.toBe(false);
    expect((await states(["turn-yield-1", "turn-yield-2"])).sort()).toEqual([
      "abandoned",
      "paused",
    ]);

    await pause("turn-auth", "auth");
    conversation.processing.activeTurnId = "turn-auth";
    conversation.processing.pendingAuth = {
      actorId: actor.userId,
      kind: "plugin",
      linkSentAtMs: Date.now(),
      provider: "github",
      sessionId: "turn-auth",
    };
    await createWebAuthorization({
      actorId: actor.userId,
      conversationId,
    }).deliver({
      authorizationUrl: "https://example.com/oauth",
      completionText: "Connected.",
      label: "GitHub",
    });

    await expect(
      supersedeOpenMailboxTurns({
        conversation,
        conversationId,
        isStopped: () => false,
        keepTurnId: "turn-kept",
      }),
    ).resolves.toBe(true);
    await expect(
      states(["turn-kept", "turn-yield-1", "turn-yield-2", "turn-auth"]),
    ).resolves.toEqual(["paused", "abandoned", "abandoned", "abandoned"]);
    // The superseded Turn is closed, and its dashboard sign-in prompt is gone.
    expect(conversation.processing.activeTurnId).toBeUndefined();
    await expect(
      getWebAuthorization({ actorId: actor.userId, conversationId }),
    ).resolves.toBeUndefined();
  });
});
