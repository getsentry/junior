import { describe, expect, it } from "vitest";
import {
  buildWebInboundMessage,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import type { ReviewItemChangeRecord } from "@/chat/review-items/change-record";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  savedTurnInputMessages,
  webConversationMessage,
} from "@/chat/task-execution/mailbox-input";
import { testViewer } from "../../fixtures/user";

const actor = webActorFromUser(testViewer("alice@example.com"));
const author = { email: actor.email, userName: "alice" };

function webMessage(
  messageId: string,
  reviewItemChange?: ReviewItemChangeRecord,
) {
  return webConversationMessage(
    buildWebInboundMessage({
      actor,
      conversationId: "local:web:batch",
      message: `Message ${messageId}`,
      messageId,
      ...(reviewItemChange ? { reviewItemChange } : undefined),
    }),
    author,
  );
}

describe("webConversationMessage", () => {
  // A batch can mix changes and typed Messages. Each keeps its own record.
  it("keeps the Review item change record of each Message", () => {
    const taken = { kind: "taken", reviewItemId: "item-a" } as const;
    expect(webMessage("a", taken).meta?.reviewItemChanges).toEqual([taken]);
    expect(webMessage("b").meta).not.toHaveProperty("reviewItemChanges");
  });
});

describe("savedTurnInputMessages", () => {
  it("returns every saved input Message of the Turn in input order", () => {
    const first = webMessage("a");
    const answer = webMessage("b", {
      kind: "submitted",
      reviewItemId: "item-b",
    });
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
