import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  processThreadMessageStep: vi.fn(),
  logThreadMessageFailureStep: vi.fn(),
  releaseWorkflowStartupLeaseStep: vi.fn()
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
  logThreadMessageFailureStep: mocks.logThreadMessageFailureStep,
  releaseWorkflowStartupLeaseStep: mocks.releaseWorkflowStartupLeaseStep
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

  it("treats async hook token conflicts as benign duplicate-start races", async () => {
    mocks.createHook.mockReturnValueOnce((async function* () {
      throw new Error('Hook token "slack:C123:1700000000.100" is already in use by another workflow');
    })());

    await expect(slackThreadWorkflow("slack:C123:1700000000.100")).resolves.toBeUndefined();
    expect(mocks.processThreadMessageStep).not.toHaveBeenCalled();
    expect(mocks.logThreadMessageFailureStep).not.toHaveBeenCalled();
  });

  it("treats non-Error hook-conflict payloads as benign duplicate-start races", async () => {
    mocks.createHook.mockReturnValueOnce((async function* () {
      throw {
        name: "WorkflowRuntimeError",
        slug: "hook-conflict",
        message: 'Hook token "slack:C123:1700000000.100" is already in use by another workflow'
      };
    })());

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

  it("releases startup lease from workflow when owner token is provided", async () => {
    const payload = createPayload();
    mocks.createHook.mockReturnValueOnce(payloadStream(payload));

    await expect(slackThreadWorkflow("slack:C123:1700000000.100", "lease-owner")).resolves.toBeUndefined();

    expect(mocks.releaseWorkflowStartupLeaseStep).toHaveBeenCalledWith(
      "slack:C123:1700000000.100",
      "lease-owner"
    );
  });
});
