import { describe, expect, it } from "vitest";
import {
  buildWebInboundMessage,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  savedTurnInputMessages,
  webConversationMessage,
} from "@/chat/task-execution/mailbox-input";

const actor = webActorFromEmail("alice@example.com");
const author = { email: actor.email, userName: "alice" };

function webMessage(messageId: string, reviewItemId?: string) {
  return webConversationMessage(
    buildWebInboundMessage({
      actor,
      conversationId: "local:web:batch",
      message: `Message ${messageId}`,
      messageId,
      ...(reviewItemId ? { reviewItemId } : undefined),
    }),
    author,
  );
}

describe("webConversationMessage", () => {
  // A batch can mix answers and typed Messages. Only the answer is marked.
  it("marks only the Message that answers a Review item", () => {
    expect(webMessage("a", "item-a").meta).toMatchObject({
      reviewItemId: "item-a",
    });
    expect(webMessage("b").meta).not.toHaveProperty("reviewItemId");
  });
});

describe("savedTurnInputMessages", () => {
  it("returns every saved input Message of the Turn in input order", () => {
    const first = webMessage("a");
    const answer = webMessage("b", "item-b");
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(answer, first);

    expect(
      savedTurnInputMessages(conversation, first, ["a", "b"]).map(
        (message) => message.id,
      ),
    ).toEqual(["a", "b"]);
  });

  // Before Messages were saved apart, the Turn Message held the joined text.
  it("returns only the Turn Message when the other inputs were not saved", () => {
    const joined = webMessage("a");
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(joined);

    expect(savedTurnInputMessages(conversation, joined, ["a", "b"])).toEqual([
      joined,
    ]);
    expect(savedTurnInputMessages(conversation, joined, undefined)).toEqual([
      joined,
    ]);
  });
});
