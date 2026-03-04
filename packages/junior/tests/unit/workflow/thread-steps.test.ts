import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  processThreadMessageRuntime: vi.fn(async () => undefined),
  getWorkflowMessageProcessingState: vi.fn(async () => undefined),
  acquireWorkflowMessageProcessingOwnership: vi.fn(async () => "acquired"),
  refreshWorkflowMessageProcessingOwnership: vi.fn(async () => true),
  completeWorkflowMessageProcessingOwnership: vi.fn(async () => true),
  failWorkflowMessageProcessingOwnership: vi.fn(async () => true),
  connectStateAdapter: vi.fn(async () => undefined)
}));

vi.mock("@/chat/thread-runtime/process-thread-message-runtime", () => ({
  processThreadMessageRuntime: mocks.processThreadMessageRuntime
}));

vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    connect: mocks.connectStateAdapter
  }),
  getWorkflowMessageProcessingState: mocks.getWorkflowMessageProcessingState,
  acquireWorkflowMessageProcessingOwnership: mocks.acquireWorkflowMessageProcessingOwnership,
  refreshWorkflowMessageProcessingOwnership: mocks.refreshWorkflowMessageProcessingOwnership,
  completeWorkflowMessageProcessingOwnership: mocks.completeWorkflowMessageProcessingOwnership,
  failWorkflowMessageProcessingOwnership: mocks.failWorkflowMessageProcessingOwnership
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
    mocks.acquireWorkflowMessageProcessingOwnership.mockResolvedValue("acquired");
  });

  it("dispatches to thread runtime and marks completion via ownership API", async () => {
    await processThreadMessageStep(createPayload("new_mention"), "wrun-123");

    expect(mocks.processThreadMessageRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.completeWorkflowMessageProcessingOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        rawKey: "slack:C123:1700000000.100:m-1",
        workflowRunId: "wrun-123",
        ownerToken: expect.any(String)
      })
    );
  });

  it("returns early when ownership is blocked", async () => {
    mocks.acquireWorkflowMessageProcessingOwnership.mockResolvedValueOnce("blocked");

    await processThreadMessageStep(createPayload("new_mention"), "wrun-123");

    expect(mocks.refreshWorkflowMessageProcessingOwnership).not.toHaveBeenCalled();
    expect(mocks.processThreadMessageRuntime).not.toHaveBeenCalled();
    expect(mocks.completeWorkflowMessageProcessingOwnership).not.toHaveBeenCalled();
  });

  it("fails without executing runtime when ownership refresh fails", async () => {
    mocks.refreshWorkflowMessageProcessingOwnership.mockResolvedValueOnce(false);

    await expect(processThreadMessageStep(createPayload("new_mention"), "wrun-123")).rejects.toThrow(
      /ownership lost during refresh/i
    );

    expect(mocks.processThreadMessageRuntime).not.toHaveBeenCalled();
    expect(mocks.failWorkflowMessageProcessingOwnership).toHaveBeenCalledTimes(1);
  });

  it("fails when completion update loses ownership", async () => {
    mocks.completeWorkflowMessageProcessingOwnership.mockResolvedValueOnce(false);

    await expect(processThreadMessageStep(createPayload("new_mention"), "wrun-123")).rejects.toThrow(
      /ownership lost during complete/i
    );

    expect(mocks.processThreadMessageRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.failWorkflowMessageProcessingOwnership).toHaveBeenCalledTimes(1);
  });
});
