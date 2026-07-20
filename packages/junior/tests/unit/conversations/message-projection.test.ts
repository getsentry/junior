import { describe, expect, it } from "vitest";
import {
  conversationEventSchema,
  type ConversationEvent,
  type ConversationEventData,
} from "@/chat/conversations/history";
import { projectConversationMessages } from "@/chat/conversations/message-projection";

function event(
  seq: number,
  createdAtMs: number,
  data: ConversationEventData,
): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    historyVersion: 0,
    createdAtMs,
    data,
  });
}

describe("message projection", () => {
  it("preserves message metadata and marks a handled message", () => {
    expect(
      projectConversationMessages([
        event(0, 1_000, {
          type: "message",
          messageId: "m1",
          role: "user",
          text: "hello",
          meta: {
            author: { userId: "U1", userName: "alice" },
            explicitMention: true,
          },
        }),
        event(1, 3_000, {
          type: "message_handled",
          messageId: "m1",
        }),
        event(2, 4_000, {
          type: "message_handled",
          messageId: "m1",
        }),
      ]),
    ).toEqual([
      {
        id: "m1",
        role: "user",
        text: "hello",
        createdAtMs: 1_000,
        author: { userId: "U1", userName: "alice" },
        meta: {
          explicitMention: true,
          replied: true,
        },
      },
    ]);
  });

  it("rejects a handled marker without an uncompacted baseline", () => {
    const data = { type: "message_handled" as const, messageId: "missing" };
    expect(() => projectConversationMessages([event(0, 1_000, data)])).toThrow(
      "before message",
    );
    expect(
      projectConversationMessages([event(10, 1_000, data)], {
        historyFromSeq: 10,
      }),
    ).toEqual([]);
  });

  it("applies the latest message state without changing its original position", () => {
    expect(
      projectConversationMessages([
        event(0, 1_000, {
          type: "message",
          messageId: "m1",
          role: "user",
          text: "hello",
          meta: { imagesHydrated: false },
        }),
        event(1, 2_000, {
          type: "message_updated",
          messageId: "m1",
          role: "user",
          text: "hello",
          meta: { imagesHydrated: true, imageFileIds: ["F1"] },
        }),
      ]),
    ).toEqual([
      {
        id: "m1",
        role: "user",
        text: "hello",
        createdAtMs: 1_000,
        meta: { imagesHydrated: true, imageFileIds: ["F1"] },
      },
    ]);
  });

  it("rejects duplicate recorded baselines", () => {
    expect(() =>
      projectConversationMessages([
        event(0, 1_000, {
          type: "message",
          messageId: "m1",
          role: "user",
          text: "first",
        }),
        event(1, 1_000, {
          type: "message",
          messageId: "m1",
          role: "user",
          text: "conflict",
        }),
      ]),
    ).toThrow("Duplicate message");
  });

  it("preserves canonical event order rather than source timestamps", () => {
    expect(
      projectConversationMessages([
        event(0, 2_000, {
          type: "message",
          messageId: "later",
          role: "assistant",
          text: "later",
        }),
        event(1, 1_000, {
          type: "message",
          messageId: "b",
          role: "user",
          text: "b",
        }),
        event(2, 1_000, {
          type: "message",
          messageId: "a",
          role: "user",
          text: "a",
        }),
      ]).map((message) => message.id),
    ).toEqual(["later", "b", "a"]);
  });
});
