import { describe, expect, it } from "vitest";
import { Message, ThreadImpl, parseMarkdown } from "chat";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { bot } from "@/chat/bot";

describe("chat sdk workflow serde contract", () => {
  it("serializes and deserializes thread and message payloads for workflow boundaries", () => {
    bot.registerSingleton();

    const thread = ThreadImpl.fromJSON({
      _type: "chat:Thread",
      adapterName: "slack",
      channelId: "slack:C123",
      id: "slack:C123:1700000000.100",
      isDM: false
    });
    const message = new Message({
      id: "1700000000.200",
      threadId: "slack:C123:1700000000.100",
      text: "hello",
      formatted: parseMarkdown("hello"),
      raw: {
        channel: "C123",
        thread_ts: "1700000000.100",
        ts: "1700000000.200"
      },
      author: {
        userId: "U_TEST",
        userName: "test-user",
        fullName: "Test User",
        isBot: false,
        isMe: false
      },
      metadata: {
        dateSent: new Date("2026-03-03T16:00:00.000Z"),
        edited: false
      },
      attachments: [
        {
          type: "file",
          url: "https://files.slack.com/private/example",
          name: "example.txt",
          data: Buffer.from("private"),
          fetchData: async () => Buffer.from("private")
        }
      ]
    });

    const serializedThread = ThreadImpl[WORKFLOW_SERIALIZE](thread);
    const serializedMessage = Message[WORKFLOW_SERIALIZE](message);

    expect(serializedThread).toMatchObject({
      _type: "chat:Thread",
      id: "slack:C123:1700000000.100",
      channelId: "slack:C123",
      adapterName: "slack"
    });
    expect(serializedMessage).toMatchObject({
      _type: "chat:Message",
      id: "1700000000.200",
      threadId: "slack:C123:1700000000.100"
    });
    expect(serializedMessage.attachments).toEqual([
      {
        type: "file",
        url: "https://files.slack.com/private/example",
        name: "example.txt"
      }
    ]);

    const deserializedThread = ThreadImpl[WORKFLOW_DESERIALIZE](serializedThread);
    const deserializedMessage = Message[WORKFLOW_DESERIALIZE](serializedMessage);

    expect(deserializedThread.id).toBe("slack:C123:1700000000.100");
    expect(deserializedThread.channelId).toBe("slack:C123");
    expect(deserializedMessage.id).toBe("1700000000.200");
    expect(deserializedMessage.threadId).toBe("slack:C123:1700000000.100");
    expect(deserializedMessage.attachments[0]).toMatchObject({
      type: "file",
      url: "https://files.slack.com/private/example",
      name: "example.txt"
    });
  });
});
