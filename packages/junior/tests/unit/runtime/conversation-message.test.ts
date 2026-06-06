import { describe, expect, it } from "vitest";
import { Message } from "chat";
import { bindMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { toConversationMessage } from "@/chat/runtime/conversation-message";

function createMessage(authorUserId = "U039RR91S") {
  return new Message({
    id: "1712345.0001",
    threadId: "slack:C123:1712345.0001",
    text: "hello",
    formatted: { type: "root", children: [] },
    raw: {},
    author: {
      userId: authorUserId,
      userName: authorUserId,
      fullName: authorUserId,
      isBot: false,
      isMe: false,
    },
    metadata: {
      dateSent: new Date("2026-06-05T00:00:00.000Z"),
      edited: false,
    },
    attachments: [],
  });
}

describe("conversation message actor identity", () => {
  it("persists the bound actor identity instead of adapter display fallbacks", () => {
    const message = createMessage();
    bindMessageActorIdentity(message, {
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });

    expect(
      toConversationMessage({
        entry: message,
        explicitMention: true,
        text: message.text,
      }).author,
    ).toEqual({
      fullName: "David Cramer",
      isBot: false,
      userId: "U039RR91S",
      userName: "dcramer",
    });
  });

  it("drops raw Slack ids from conversation author display fields", () => {
    expect(
      toConversationMessage({
        entry: createMessage(),
        explicitMention: true,
        text: "hello",
      }).author,
    ).toEqual({
      isBot: false,
      userId: "U039RR91S",
    });
  });

  it("does not persist unbound adapter display fields as actor identity", () => {
    const message = createMessage();
    message.author.userName = "dcramer";
    message.author.fullName = "David Cramer";

    expect(
      toConversationMessage({
        entry: message,
        explicitMention: true,
        text: "hello",
      }).author,
    ).toEqual({
      isBot: false,
      userId: "U039RR91S",
    });
  });

  it("binds resolved identity when the adapter supplied unknown", () => {
    const message = createMessage("unknown");
    bindMessageActorIdentity(message, {
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });

    expect(
      toConversationMessage({
        entry: message,
        explicitMention: true,
        text: "hello",
      }).author,
    ).toEqual({
      fullName: "David Cramer",
      isBot: false,
      userId: "U039RR91S",
      userName: "dcramer",
    });
  });

  it("rejects actor identity mismatches", () => {
    expect(() =>
      bindMessageActorIdentity(createMessage(), {
        fullName: "Other Person",
        userId: "U_OTHER",
        userName: "other",
      }),
    ).toThrow("Message actor identity user id mismatch");
  });
});
