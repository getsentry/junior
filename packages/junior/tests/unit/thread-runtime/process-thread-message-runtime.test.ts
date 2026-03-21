import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleNewMentionMock, handleSubscribedMessageMock } = vi.hoisted(
  () => ({
    handleNewMentionMock: vi.fn(async () => undefined),
    handleSubscribedMessageMock: vi.fn(async () => undefined),
  }),
);

vi.mock("@/chat/bot", () => ({
  appSlackRuntime: {
    handleNewMention: handleNewMentionMock,
    handleSubscribedMessage: handleSubscribedMessageMock,
  },
}));

vi.mock("@/chat/slack-actions/client", () => ({
  downloadPrivateSlackFile: vi.fn(async () => Buffer.from("")),
}));

import { processThreadMessageRuntime } from "@/chat/thread-runtime/process-thread-message-runtime";

describe("processThreadMessageRuntime", () => {
  beforeEach(() => {
    handleNewMentionMock.mockClear();
    handleSubscribedMessageMock.mockClear();
  });

  it("forwards pre-approved opt-out decisions to subscribed message handling", async () => {
    const thread = {
      channelId: "C123",
    } as Parameters<typeof processThreadMessageRuntime>[0]["thread"];
    const message = {
      id: "1700000000.200",
      attachments: [],
      author: {
        userId: "U_TEST",
        isMe: false,
      },
    } as unknown as Parameters<
      typeof processThreadMessageRuntime
    >[0]["message"];
    const preApprovedDecision = {
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: "thread_opt_out:user asked junior to stop",
    } as const;

    await processThreadMessageRuntime({
      kind: "subscribed_message",
      message,
      preApprovedDecision,
      thread,
    });

    expect(handleNewMentionMock).not.toHaveBeenCalled();
    expect(handleSubscribedMessageMock).toHaveBeenCalledWith(
      thread,
      message,
      expect.objectContaining({
        preApprovedDecision,
      }),
    );
  });
});
