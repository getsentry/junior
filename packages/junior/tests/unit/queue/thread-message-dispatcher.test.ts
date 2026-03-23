import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadMessageDispatcher } from "@/chat/queue/thread-message-dispatcher";

describe("createThreadMessageDispatcher", () => {
  const handleNewMentionMock = vi.fn(async () => undefined);
  const handleSubscribedMessageMock = vi.fn(async () => undefined);

  beforeEach(() => {
    handleNewMentionMock.mockClear();
    handleSubscribedMessageMock.mockClear();
  });

  it("forwards subscribed messages to subscribed message handling", async () => {
    const dispatch = createThreadMessageDispatcher({
      runtime: {
        handleNewMention: handleNewMentionMock,
        handleSubscribedMessage: handleSubscribedMessageMock,
      },
      downloadPrivateSlackFile: vi.fn(async () => Buffer.from("")),
    });
    const thread = {
      channelId: "C123",
    } as Parameters<typeof dispatch>[0]["thread"];
    const message = {
      id: "1700000000.200",
      attachments: [],
      author: {
        userId: "U_TEST",
        isMe: false,
      },
    } as unknown as Parameters<typeof dispatch>[0]["message"];

    await dispatch({
      kind: "subscribed_message",
      message,
      thread,
    });

    expect(handleNewMentionMock).not.toHaveBeenCalled();
    expect(handleSubscribedMessageMock).toHaveBeenCalledWith(
      thread,
      message,
      expect.objectContaining({}),
    );
  });
});
