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
    mocks.start.mockResolvedValueOnce(undefined);

    const promise = routeToThreadWorkflow("slack:C123:1700000000.100", payload);
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(mocks.slackThreadWorkflow, ["slack:C123:1700000000.100"]);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenNthCalledWith(1, "slack:C123:1700000000.100", payload);
    expect(mocks.resume).toHaveBeenNthCalledWith(2, "slack:C123:1700000000.100", payload);
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
    expect(delays).toEqual(expect.arrayContaining([50, 100]));
    setTimeoutSpy.mockRestore();
  });

  it("handles concurrent route attempts for the same thread without dropping either call", async () => {
    const payloadA = createPayload();
    const payloadB = createPayload();
    mocks.resume
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ hookId: "hook-1" });
    mocks.start.mockResolvedValueOnce({ runId: "wrun-1" }).mockRejectedValueOnce(new Error("hook conflict"));

    const routeA = routeToThreadWorkflow("slack:C123:1700000000.100", payloadA);
    const routeB = routeToThreadWorkflow("slack:C123:1700000000.100", payloadB);
    await vi.runAllTimersAsync();

    await expect(Promise.all([routeA, routeB])).resolves.toEqual(["wrun-1", undefined]);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenCalledTimes(4);
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
