import { describe, expect, it } from "vitest";
import {
  conversationEventSchema,
  type ConversationEvent,
  type ConversationEventData,
} from "@/chat/conversations/history";
import { projectVisibleConversationMessages } from "@/chat/conversations/visible-message-projection";

function event(
  seq: number,
  createdAtMs: number,
  data: ConversationEventData,
): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: 1,
    seq,
    contextEpoch: 0,
    createdAtMs,
    data,
  });
}

describe("visible message projection", () => {
  it("merges metadata and preserves the first replied fact", () => {
    expect(
      projectVisibleConversationMessages([
        event(0, 1_000, {
          type: "visible_message_recorded",
          messageId: "m1",
          role: "user",
          text: "hello",
          meta: {
            author: { userId: "U1", userName: "alice" },
            explicitMention: true,
          },
        }),
        event(1, 2_000, {
          type: "visible_message_metadata_updated",
          messageId: "m1",
          meta: {
            author: { userId: "U1", userName: "alice", fullName: "Alice" },
            imageFileIds: ["F1"],
          },
        }),
        event(2, 3_000, {
          type: "visible_message_replied",
          messageId: "m1",
        }),
        event(3, 4_000, {
          type: "visible_message_replied",
          messageId: "m1",
        }),
      ]),
    ).toEqual([
      {
        id: "m1",
        role: "user",
        text: "hello",
        createdAtMs: 1_000,
        author: { userId: "U1", userName: "alice", fullName: "Alice" },
        meta: {
          explicitMention: true,
          imageFileIds: ["F1"],
          replied: true,
        },
      },
    ]);
  });

  it.each([
    "visible_message_metadata_updated",
    "visible_message_replied",
  ] as const)("ignores %s without a live recorded baseline", (type) => {
    const data =
      type === "visible_message_metadata_updated"
        ? { type, messageId: "missing", meta: { late: true } }
        : { type, messageId: "missing" };
    expect(projectVisibleConversationMessages([event(0, 1_000, data)])).toEqual(
      [],
    );
  });

  it("rejects duplicate recorded baselines", () => {
    expect(() =>
      projectVisibleConversationMessages([
        event(0, 1_000, {
          type: "visible_message_recorded",
          messageId: "m1",
          role: "user",
          text: "first",
        }),
        event(1, 1_000, {
          type: "visible_message_recorded",
          messageId: "m1",
          role: "user",
          text: "conflict",
        }),
      ]),
    ).toThrow("Duplicate visible_message_recorded");
  });

  it("preserves canonical event order rather than source timestamps", () => {
    expect(
      projectVisibleConversationMessages([
        event(0, 2_000, {
          type: "visible_message_recorded",
          messageId: "later",
          role: "assistant",
          text: "later",
        }),
        event(1, 1_000, {
          type: "visible_message_recorded",
          messageId: "b",
          role: "user",
          text: "b",
        }),
        event(2, 1_000, {
          type: "visible_message_recorded",
          messageId: "a",
          role: "user",
          text: "a",
        }),
      ]).map((message) => message.id),
    ).toEqual(["later", "b", "a"]);
  });
});
