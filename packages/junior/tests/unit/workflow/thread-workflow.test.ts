import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  processThreadMessageStep: vi.fn(),
  logThreadMessageFailureStep: vi.fn()
}));

vi.mock("workflow", () => ({
  defineHook: () => ({
    create: mocks.createHook
  }),
  getWorkflowMetadata: () => ({
    workflowRunId: "wrun-test"
  })
}));

vi.mock("@/chat/workflow/thread-steps", () => ({
  processThreadMessageStep: mocks.processThreadMessageStep,
  logThreadMessageFailureStep: mocks.logThreadMessageFailureStep
}));

import { slackThreadWorkflow } from "@/chat/workflow/thread-workflow";

async function* payloadStream(payload: ThreadMessagePayload): AsyncIterable<ThreadMessagePayload> {
  yield payload;
}

function createPayload(): ThreadMessagePayload {
  return {
    dedupKey: "slack:C123:1700000000.100:m-1",
    kind: "new_mention",
    normalizedThreadId: "slack:C123:1700000000.100",
    message: {
      id: "m-1",
      author: {
        userId: "U123"
      }
    } as ThreadMessagePayload["message"],
    thread: {
      channelId: "C123"
    } as ThreadMessagePayload["thread"]
  };
}

describe("slackThreadWorkflow", () => {
  it("treats hook token conflicts as benign duplicate-start races", async () => {
    mocks.createHook.mockImplementationOnce(() => {
      throw new Error('Hook token "slack:C123:1700000000.100" is already in use by another workflow');
    });

    await expect(slackThreadWorkflow("slack:C123:1700000000.100")).resolves.toBeUndefined();
    expect(mocks.processThreadMessageStep).not.toHaveBeenCalled();
    expect(mocks.logThreadMessageFailureStep).not.toHaveBeenCalled();
  });

  it("logs per-message failures and continues loop", async () => {
    const payload = createPayload();
    mocks.createHook.mockReturnValueOnce(payloadStream(payload));
    mocks.processThreadMessageStep.mockRejectedValueOnce(new Error("boom"));

    await expect(slackThreadWorkflow("slack:C123:1700000000.100")).resolves.toBeUndefined();

    expect(mocks.processThreadMessageStep).toHaveBeenCalledWith(payload, "wrun-test");
    expect(mocks.logThreadMessageFailureStep).toHaveBeenCalledWith(payload, "boom", "wrun-test");
  });
});
