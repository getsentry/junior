import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  handleNewMention: vi.fn(async () => undefined),
  handleSubscribedMessage: vi.fn(async () => undefined),
  downloadPrivateSlackFile: vi.fn(async () => Buffer.from("")),
  getWorkflowMessageProcessingState: vi.fn(async () => undefined),
  markWorkflowMessageStarted: vi.fn(async () => true),
  markWorkflowMessageCompleted: vi.fn(async () => undefined),
  markWorkflowMessageFailed: vi.fn(async () => undefined),
  connectStateAdapter: vi.fn(async () => undefined)
}));

vi.mock("@/chat/bot", () => ({
  appSlackRuntime: {
    handleNewMention: mocks.handleNewMention,
    handleSubscribedMessage: mocks.handleSubscribedMessage
  }
}));

vi.mock("@/chat/slack-actions/client", () => ({
  downloadPrivateSlackFile: mocks.downloadPrivateSlackFile
}));

vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    connect: mocks.connectStateAdapter
  }),
  getWorkflowMessageProcessingState: mocks.getWorkflowMessageProcessingState,
  markWorkflowMessageStarted: mocks.markWorkflowMessageStarted,
  markWorkflowMessageCompleted: mocks.markWorkflowMessageCompleted,
  markWorkflowMessageFailed: mocks.markWorkflowMessageFailed
}));

import { processThreadMessageStep } from "@/chat/workflow/thread-steps";

function createPayload(kind: ThreadMessagePayload["kind"]): ThreadMessagePayload {
  return {
    dedupKey: "slack:C123:1700000000.100:m-1",
    kind,
    normalizedThreadId: "slack:C123:1700000000.100",
    message: {
      id: "m-1",
      text: "hello",
      attachments: [],
      author: {
        userId: "U123"
      }
    } as ThreadMessagePayload["message"],
    thread: {
      id: "slack:C123:1700000000.100",
      channelId: "C123"
    } as ThreadMessagePayload["thread"]
  };
}

describe("processThreadMessageStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkflowMessageProcessingState.mockResolvedValue(undefined);
    mocks.markWorkflowMessageStarted.mockResolvedValue(true);
  });

  it("does not require bot export from @/chat/bot", async () => {
    await processThreadMessageStep(createPayload("new_mention"), "wrun-123");

    expect(mocks.handleNewMention).toHaveBeenCalledTimes(1);
    expect(mocks.markWorkflowMessageCompleted).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:m-1",
      "wrun-123"
    );
  });
});
