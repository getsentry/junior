import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatDuration,
  formatElapsedDuration,
  formatRelativeTime,
  formatRuntime,
} from "../src/client/time";
import { NOW_MS } from "../src/mock-reporting/fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("time formatting", () => {
  it("formats durations as compact units at increasing scales", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(3_500)).toBe("3.5s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(2_700_000)).toBe("45m");
    expect(formatDuration(4_500_000)).toBe("1h 15m");
    expect(formatDuration(90_061_000)).toBe("1d 1h");
    expect(formatDuration(839_497_000)).toBe("9d 17h");
    expect(formatDuration(839_497_000, 1)).toBe("9d");
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });

  it("formats recorded runtimes and elapsed event durations", () => {
    expect(formatRuntime(3_500)).toBe("3.5s");
    expect(formatRuntime(0)).toBe("");
    expect(formatRuntime(undefined)).toBe("");
    expect(formatElapsedDuration(1_000, 4_500)).toBe("3.5s");
    expect(formatElapsedDuration(undefined, 4_500)).toBeUndefined();
    expect(formatElapsedDuration(4_500, 1_000)).toBeUndefined();
  });

  it("formats times relative to now", () => {
    vi.useFakeTimers({ now: NOW_MS });
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(formatRelativeTime(NOW_MS - 30_000)).toBe("just now");
    expect(formatRelativeTime(iso(NOW_MS - 5 * 60_000))).toBe("5 minutes ago");
    expect(formatRelativeTime(NOW_MS - 86_400_000)).toBe("yesterday");
    expect(formatRelativeTime(iso(NOW_MS + 2 * 3_600_000))).toBe("in 2 hours");
    expect(formatRelativeTime(undefined)).toBe("not updated yet");
    expect(formatRelativeTime("not a date", "never")).toBe("never");
  });
});
