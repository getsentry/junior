import { describe, expect, it, vi } from "vitest";
import type { Adapter } from "chat";
import { JuniorChat } from "@/chat/ingress/junior-chat";

describe("Slack behavior: inbound message shape", () => {
  it("ignores non-object inbound messages without crashing", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;
    const fakeChat = {
      logger: {
        error: vi.fn(),
      },
      createThread: vi.fn(async () => ({ channelId: "slack:C123" })),
      detectMention: vi.fn(() => false),
    };

    processMessage.call(
      fakeChat,
      adapter,
      "slack:C123:1700000000.100",
      "not-an-object",
      {
        waitUntil(task: Promise<unknown>) {
          waitUntilTasks.push(task);
        },
      },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();
    expect(fakeChat.createThread).not.toHaveBeenCalled();
    expect(fakeChat.logger.error).not.toHaveBeenCalled();
  });

  it("logs missing_message_id and exits before routing", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;
    const fakeChat = {
      logger: {
        error: vi.fn(),
      },
      createThread: vi.fn(async () => ({ channelId: "slack:C123" })),
      detectMention: vi.fn(() => false),
    };

    processMessage.call(
      fakeChat,
      adapter,
      "slack:C123:",
      {
        id: "",
        isMention: true,
        raw: {
          channel: "C123",
          ts: "1700000000.200",
        },
        attachments: [],
        author: {
          userId: "U_TEST",
          isMe: false,
        },
      },
      {
        waitUntil(task: Promise<unknown>) {
          waitUntilTasks.push(task);
        },
      },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();
    expect(fakeChat.createThread).not.toHaveBeenCalled();
    expect(fakeChat.logger.error).toHaveBeenCalledWith(
      "Message processing error",
      {
        threadId: "slack:C123:1700000000.200",
        reason: "missing_message_id",
      },
    );
  });
});
