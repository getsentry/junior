import { describe, expect, it, vi } from "vitest";
import {
  createEventMatchCache,
  runWithEventMatchCache,
} from "@/chat/events/match-cache";

describe("event match cache", () => {
  it("loads each key once within a request", async () => {
    const cache = createEventMatchCache<number>();
    const load = vi.fn(async () => 1);
    await runWithEventMatchCache(async () => {
      expect(await cache("a", load)).toBe(1);
      expect(await cache("a", load)).toBe(1);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not share reads between requests", async () => {
    const cache = createEventMatchCache<number>();
    const load = vi.fn(async () => 1);
    await runWithEventMatchCache(async () => await cache("a", load));
    await runWithEventMatchCache(async () => await cache("a", load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads fresh outside a request", async () => {
    const cache = createEventMatchCache<number>();
    const load = vi.fn(async () => 1);
    await cache("a", load);
    await cache("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read", async () => {
    const cache = createEventMatchCache<number>();
    const load = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(2);
    await runWithEventMatchCache(async () => {
      await expect(cache("a", load)).rejects.toThrow("boom");
      expect(await cache("a", load)).toBe(2);
    });
  });
});
