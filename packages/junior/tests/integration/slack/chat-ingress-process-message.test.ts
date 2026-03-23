import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "chat";
import { JuniorChat } from "@/chat/ingress/junior-chat";

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

describe("chat background processMessage", () => {
  afterEach(() => {
    if (ORIGINAL_REDIS_URL === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    }
  });

  it("logs workflow routing failures without rejecting the background task", async () => {
    delete process.env.REDIS_URL;

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
      {
        id: "1700000000.200",
        isMention: true,
        raw: {
          channel: "C123",
          thread_ts: "1700000000.100",
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
    expect(fakeChat.logger.error).toHaveBeenCalledWith(
      "Message processing error",
      {
        error: expect.any(Error),
        threadId: "slack:C123:1700000000.100",
      },
    );
  });
});
