import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  slackThreadWorkflow: vi.fn(),
  start: vi.fn()
}));

vi.mock("workflow/api", () => ({
  start: mocks.start
}));

vi.mock("@/chat/workflow/thread-workflow", () => ({
  slackThreadWorkflow: mocks.slackThreadWorkflow,
  threadMessageHook: {
    resume: mocks.resume
  }
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses resume directly when hook exists", async () => {
    mocks.resume.mockResolvedValueOnce({ hookId: "hook-1" });

    await routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("starts workflow when first resume misses and retries resume", async () => {
    mocks.resume.mockResolvedValueOnce(null).mockResolvedValueOnce({ hookId: "hook-1" });
    mocks.start.mockResolvedValueOnce(undefined);

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
  });

  it("throws when all resume attempts fail", async () => {
    mocks.resume.mockResolvedValue(null);
    mocks.start.mockImplementationOnce(async () => {
      throw new Error("start failed");
    });

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("Hook resume returned no hook entity");
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(6);
  });

  it("throws when all resume attempts raise errors", async () => {
    mocks.resume.mockImplementation(async () => {
      throw new Error("resume failed");
    });
    mocks.start.mockResolvedValueOnce(undefined);

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", createPayload());
    const capturedErrorPromise = promise.catch((error) => error);
    await vi.runAllTimersAsync();
    const capturedError = await capturedErrorPromise;

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("resume failed");
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(6);
  });
});
