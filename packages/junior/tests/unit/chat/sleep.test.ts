import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "@/chat/sleep";

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the requested duration", async () => {
    vi.useFakeTimers();
    const wait = sleep(100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(wait).resolves.toBeUndefined();
  });

  it("rejects with the owning signal reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const wait = sleep(100, controller.signal);

    controller.abort(reason);

    await expect(wait).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);

    await expect(sleep(100, controller.signal)).rejects.toBe(reason);
  });
});
