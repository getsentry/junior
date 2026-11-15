import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatActivityDay,
  formatCompactAge,
  formatDuration,
  formatElapsedDuration,
  formatRelativeTime,
  formatRuntime,
  formatTime,
  formatTranscriptTimestampDetails,
} from "../src/client/time";
import { NOW_MS } from "../src/mock-reporting/fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

  it("formats absolute timestamps in the viewer's browser timezone", () => {
    const value = "2026-08-10T16:00:00.000Z";
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "medium",
      timeStyle: "short",
    };
    vi.stubEnv("TZ", "UTC");
    expect(formatTime(value, options)).toBe("Aug 10, 2026, 4:00 PM");
    expect(formatTime(value)).toBe("8/10/2026, 4:00:00 PM");
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(formatTime(value, options)).toBe("Aug 10, 2026, 9:00 AM");
    expect(formatTime(value, { ...options, timeZone: "UTC" })).toBe(
      "Aug 10, 2026, 4:00 PM",
    );
    expect(formatTime(undefined)).toBe("none");
  });

  it("formats canonical transcript timestamp details in local time and UTC", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const details = formatTranscriptTimestampDetails(
      Date.parse("2026-08-10T16:00:00.000Z"),
    );
    expect(details.local).toContain("9:00:00 AM");
    expect(details.utc).toContain("4:00:00 PM");
  });

  it("formats compact ages and activity days for conversation rows", () => {
    vi.stubEnv("TZ", "UTC");
    const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
    expect(formatCompactAge(ago(30_000), NOW_MS)).toBe("now");
    expect(formatCompactAge(ago(12 * 60_000), NOW_MS)).toBe("12m");
    expect(formatCompactAge(ago(3 * 3_600_000), NOW_MS)).toBe("3h");
    expect(formatCompactAge(ago(2 * 86_400_000), NOW_MS)).toBe("2d");
    expect(formatCompactAge(ago(15 * 86_400_000), NOW_MS)).toBe("2w");
    expect(formatCompactAge("2026-06-20T12:00:00.000Z", NOW_MS)).toBe("Jun 20");

    const now = Date.parse("2026-11-05T18:00:00.000Z");
    const format = (value: string) => formatActivityDay(value, now, "UTC");
    expect(format("2026-11-05T09:05:00.000Z")).toBe("9:05 AM");
    expect(format("2026-11-04T23:59:00.000Z")).toBe("Yesterday");
    expect(format("2026-11-01T12:00:00.000Z")).toBe("Sun");
    expect(format("2026-08-15T12:00:00.000Z")).toBe("Aug 15");
    expect(format("2025-12-31T12:00:00.000Z")).toBe("Dec 31, 2025");
    expect(format("not a date")).toBe("");
  });
});
