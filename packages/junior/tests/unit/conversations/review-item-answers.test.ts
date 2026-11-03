import { describe, expect, it } from "vitest";
import {
  buildWebInboundMessage,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import { batchReviewItemIds } from "@/chat/task-execution/mailbox-input";

const actor = webActorFromEmail("alice@example.com");

function webMessage(messageId: string, reviewItemId?: string) {
  return buildWebInboundMessage({
    actor,
    conversationId: "local:web:review",
    message: `Message ${messageId}`,
    messageId,
    ...(reviewItemId ? { reviewItemId } : undefined),
  });
}

describe("batchReviewItemIds", () => {
  it("names the items of a batch of answers", () => {
    expect(
      batchReviewItemIds([
        webMessage("a", "item-a"),
        webMessage("b", "item-b"),
      ]),
    ).toEqual(["item-a", "item-b"]);
  });

  // A batch that also holds a typed Message must still show as text.
  it("names no items when a Message in the batch is not an answer", () => {
    expect(
      batchReviewItemIds([webMessage("a", "item-a"), webMessage("b")]),
    ).toBeUndefined();
  });
});
