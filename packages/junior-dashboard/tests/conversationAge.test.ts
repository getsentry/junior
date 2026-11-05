import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatActivityDay,
  formatCompactAge,
} from "../src/client/conversations/conversationAge";
import { NOW_MS } from "../src/mock-reporting/fixtures";

describe("conversation age", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats compact ages for dense conversation rows", () => {
    vi.stubEnv("TZ", "UTC");
    const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
    expect(formatCompactAge(ago(30_000), NOW_MS)).toBe("now");
    expect(formatCompactAge(ago(12 * 60_000), NOW_MS)).toBe("12m");
    expect(formatCompactAge(ago(3 * 3_600_000), NOW_MS)).toBe("3h");
    expect(formatCompactAge(ago(2 * 86_400_000), NOW_MS)).toBe("2d");
    expect(formatCompactAge(ago(15 * 86_400_000), NOW_MS)).toBe("2w");
    expect(formatCompactAge("2026-06-20T12:00:00.000Z", NOW_MS)).toBe("Jun 20");
  });

  it("formats the activity day for conversation cards", () => {
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
