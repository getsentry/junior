import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  slackThreadWorkflow: vi.fn(),
  start: vi.fn(),
  claimWorkflowStartupLease: vi.fn(),
  randomUUID: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  withContext: vi.fn()
}));

vi.mock("workflow/api", () => ({
  start: mocks.start
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID
}));

vi.mock("@/chat/state", () => ({
  claimWorkflowStartupLease: mocks.claimWorkflowStartupLease
}));

vi.mock("@/chat/workflow/thread-workflow", () => ({
  slackThreadWorkflow: mocks.slackThreadWorkflow,
  threadMessageHook: {
    resume: mocks.resume
  }
}));

vi.mock("@/chat/observability", () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
  withContext: mocks.withContext
}));

import { routeToThreadWorkflow } from "@/chat/workflow/router";

function createPayload(): ThreadMessagePayload {
  return {
    dedupKey: "slack:C123:1700000000.100:1700000000.200",
    kind: "new_mention",
    message: {
      author: {
        userId: "U_TEST"
      }
    } as ThreadMessagePayload["message"],
    normalizedThreadId: "slack:C123:1700000000.100",
    thread: {
      channelId: "slack:C123"
    } as ThreadMessagePayload["thread"]
  };
}

describe("routeToThreadWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.randomUUID.mockReturnValue("lease-token-1");
    mocks.claimWorkflowStartupLease.mockResolvedValue(true);
    mocks.withContext.mockImplementation(async (_context: unknown, callback: () => Promise<unknown>) => callback());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses resume directly when hook exists", async () => {
    const payload = createPayload();
    mocks.resume.mockResolvedValueOnce({ hookId: "hook-1" });

    await routeToThreadWorkflow("slack:C123:1700000000.100", payload);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledWith("slack:C123:1700000000.100", payload);
  });

  it("starts workflow when first resume misses and retries resume", async () => {
    const payload = createPayload();
    mocks.resume.mockResolvedValueOnce(null).mockResolvedValueOnce({ hookId: "hook-1" });
    mocks.start.mockResolvedValueOnce({ runId: "wrun-1" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", payload);
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(mocks.slackThreadWorkflow, ["slack:C123:1700000000.100", "lease-token-1"]);
    expect(mocks.claimWorkflowStartupLease).toHaveBeenCalledWith("slack:C123:1700000000.100", "lease-token-1", 3000);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenNthCalledWith(1, "slack:C123:1700000000.100", payload);
    expect(mocks.resume).toHaveBeenNthCalledWith(2, "slack:C123:1700000000.100", payload);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "workflow_route_start_attempt",
      {},
      expect.objectContaining({
        "app.workflow.resume_miss_reason": "resume_empty"
      }),
      "Starting thread workflow after expected resume miss"
    );
  });

  it("continues retrying resume when start throws a race error", async () => {
    const payload = createPayload();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mocks.resume
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hookId: "hook-1" });
    mocks.start.mockRejectedValueOnce(new Error("hook conflict"));

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", payload);
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(4);
    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((value): value is number => typeof value === "number");
    expect(delays).toEqual(expect.arrayContaining([250, 750]));
    setTimeoutSpy.mockRestore();
  });

  it("acts as follower when startup lease is already held and avoids duplicate starts", async () => {
    const payload = createPayload();
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(false);
    mocks.resume.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ hookId: "hook-1" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", payload);
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(3);
  });

  it("throws when all resume attempts fail", async () => {
    mocks.resume.mockResolvedValue(null);
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(true);
    mocks.start.mockRejectedValueOnce(new Error("hook conflict"));

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("Hook resume returned no hook entity");
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(4);
  });

  it("throws when all resume attempts raise errors", async () => {
    mocks.resume.mockImplementation(async () => {
      throw new Error("resume failed");
    });
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(true);
    mocks.start.mockResolvedValueOnce({ runId: "wrun-1" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("resume failed");
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(4);
  });

  it("throws start errors that are not benign races", async () => {
    const payload = createPayload();
    mocks.resume.mockResolvedValueOnce(null);
    mocks.start.mockRejectedValueOnce(new Error("workflow service unavailable"));

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", payload);
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("workflow service unavailable");
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("logs retry misses with retry reason attributes", async () => {
    mocks.resume
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hookId: "hook-1" });
    mocks.start.mockResolvedValueOnce({ runId: "wrun-1" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    await vi.runAllTimersAsync();
    await promise;

    const retryInfoCalls = mocks.logInfo.mock.calls.filter(([eventName]) => eventName === "workflow_route_resume_retry");
    const retryWarnCalls = mocks.logWarn.mock.calls.filter(([eventName]) => eventName === "workflow_route_resume_retry");
    expect(retryInfoCalls).toHaveLength(2);
    expect(retryWarnCalls).toHaveLength(0);
    for (const call of [...retryInfoCalls, ...retryWarnCalls]) {
      const attributes = call[2] as Record<string, unknown>;
      expect(attributes["app.workflow.retry_reason"]).toBeDefined();
      expect(attributes["app.workflow.retry_phase"]).toBeDefined();
    }
  });

  it("tries to become leader after follower retries are exhausted", async () => {
    mocks.randomUUID.mockReturnValueOnce("lease-token-1").mockReturnValueOnce("lease-token-2");
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.resume
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hookId: "hook-1" });
    mocks.start.mockResolvedValueOnce({ runId: "wrun-2" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.claimWorkflowStartupLease).toHaveBeenNthCalledWith(1, "slack:C123:1700000000.100", "lease-token-1", 3000);
    expect(mocks.claimWorkflowStartupLease).toHaveBeenNthCalledWith(2, "slack:C123:1700000000.100", "lease-token-2", 3000);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("uses final safety resume window when fallback lease is contended", async () => {
    mocks.randomUUID.mockReturnValueOnce("lease-token-1").mockReturnValueOnce("lease-token-2");
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    mocks.resume
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hookId: "hook-1" });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(6);
  });

  it("fails only after final safety resume window is exhausted", async () => {
    mocks.randomUUID.mockReturnValueOnce("lease-token-1").mockReturnValueOnce("lease-token-2");
    mocks.claimWorkflowStartupLease.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    mocks.resume.mockResolvedValue(null);

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("Hook resume returned no hook entity");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(6);
    expect(mocks.logError).toHaveBeenCalledWith(
      "workflow_route_failed",
      {},
      expect.objectContaining({
        "app.workflow.message_kind": "new_mention"
      }),
      "Failed to route message to thread workflow"
    );
  });
});
