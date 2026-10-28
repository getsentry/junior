import { describe, expect, it } from "vitest";

import {
  WINDOW_SEVEN_DAY_HOURS,
  WINDOW_SIX_HOURS,
  fillUtcHours,
  fillUtcSixHours,
  sumUtcHoursIntoSixHours,
  startOfUtcSixHour,
  utcSixHourKey,
} from "@/api/reporting-window";

describe("reporting-window six-hour buckets", () => {
  const nowMs = Date.parse("2026-06-15T14:30:00.000Z");

  it("snaps six-hour buckets to 00/06/12/18 UTC", () => {
    expect(utcSixHourKey(nowMs)).toBe("2026-06-15T12");
    expect(
      startOfUtcSixHour(Date.parse("2026-06-15T00:00:00.000Z")).toISOString(),
    ).toBe("2026-06-15T00:00:00.000Z");
    expect(
      startOfUtcSixHour(Date.parse("2026-06-15T05:59:00.000Z")).toISOString(),
    ).toBe("2026-06-15T00:00:00.000Z");
    expect(
      startOfUtcSixHour(Date.parse("2026-06-15T18:01:00.000Z")).toISOString(),
    ).toBe("2026-06-15T18:00:00.000Z");
  });

  it("fills 168 hour points and 28 six-hour points", () => {
    const hours = fillUtcHours({
      count: WINDOW_SEVEN_DAY_HOURS,
      empty: (date) => ({ date, value: 0 }),
      nowMs,
      rows: new Map(),
    });
    expect(hours).toHaveLength(168);
    // 168 inclusive hours ending at 14:00 start at 15:00 the prior week.
    expect(hours[0]?.date).toBe("2026-06-08T15");
    expect(hours.at(-1)?.date).toBe("2026-06-15T14");

    const six = fillUtcSixHours({
      empty: (date) => ({ date, value: 0 }),
      nowMs,
      rows: new Map([["2026-06-15T12", { date: "2026-06-15T12", value: 3 }]]),
    });
    expect(six).toHaveLength(WINDOW_SIX_HOURS);
    expect(six.at(-1)).toEqual({ date: "2026-06-15T12", value: 3 });
  });

  it("sums hour rows into six-hour buckets", () => {
    // End in the 18:00 bucket so both the 12:00 and 18:00 rolls are in-window.
    const endInEighteenMs = Date.parse("2026-06-15T19:30:00.000Z");
    const hours = [
      { date: "2026-06-15T12", value: 1 },
      { date: "2026-06-15T13", value: 2 },
      { date: "2026-06-15T17", value: 4 },
      { date: "2026-06-15T18", value: 8 },
    ];
    const six = sumUtcHoursIntoSixHours({
      empty: (date) => ({ date, value: 0 }),
      hours,
      nowMs: endInEighteenMs,
    });
    expect(six).toHaveLength(WINDOW_SIX_HOURS);
    expect(six.find((row) => row.date === "2026-06-15T12")).toEqual({
      date: "2026-06-15T12",
      value: 7,
    });
    expect(six.find((row) => row.date === "2026-06-15T18")).toEqual({
      date: "2026-06-15T18",
      value: 8,
    });
    expect(six.at(-1)?.date).toBe("2026-06-15T18");
  });

  it("sums hour-keyed values after filling the hour window", () => {
    const hours = fillUtcHours({
      count: WINDOW_SEVEN_DAY_HOURS,
      empty: (date) => ({ date, value: 0 }),
      nowMs,
      rows: new Map([
        ["2026-06-15T13", { date: "2026-06-15T13", value: 2 }],
        ["2026-06-15T14", { date: "2026-06-15T14", value: 3 }],
      ]),
    });
    const six = sumUtcHoursIntoSixHours({
      empty: (date) => ({ date, value: 0 }),
      hours,
      nowMs,
    });
    expect(six.find((row) => row.date === "2026-06-15T12")).toEqual({
      date: "2026-06-15T12",
      value: 5,
    });
  });
});
