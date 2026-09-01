import { describe, expect, it } from "vitest";

import {
  selectTimeSeries,
  timeRangeBucketAdjective,
  timeRangeBucketAverageUnit,
  timeRangeBucketPerLabel,
  timeRangeBucketUnit,
} from "../src/client/components/controls/TimeRangeSelector";

describe("timeRangeBucketUnit", () => {
  it("maps ranges to day/hour/6hour", () => {
    expect(timeRangeBucketUnit(1)).toBe("hour");
    expect(timeRangeBucketUnit(7)).toBe("6hour");
    expect(timeRangeBucketUnit(30)).toBe("day");
    expect(timeRangeBucketUnit(90)).toBe("day");
  });
});

describe("bucket labels", () => {
  it("formats average and prose units", () => {
    expect(timeRangeBucketAverageUnit("hour")).toBe("hour");
    expect(timeRangeBucketAverageUnit("6hour")).toBe("6h");
    expect(timeRangeBucketAverageUnit("day")).toBe("day");
    expect(timeRangeBucketPerLabel("6hour")).toBe("6 hours");
    expect(timeRangeBucketAdjective("6hour")).toBe("6-hour");
  });
});

describe("selectTimeSeries", () => {
  const days = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    value: index,
  }));
  const hours = Array.from({ length: 48 }, (_, index) => {
    const date = new Date(Date.parse("2026-06-15T00:00:00.000Z") + index * 3600_000);
    return { date: date.toISOString().slice(0, 13), value: 1 };
  });

  it("keeps trailing 24 hours for 24h range even when hours are longer", () => {
    const longHours = Array.from({ length: 168 }, (_, index) => {
      const date = new Date(Date.parse("2026-06-08T14:00:00.000Z") + index * 3600_000);
      return { date: date.toISOString().slice(0, 13), value: 1 };
    });
    const series = selectTimeSeries({ days, hours: longHours, range: 1 });
    expect(series).toHaveLength(24);
    expect(series[0]?.date).toBe(longHours.slice(-24)[0]?.date);
  });

  it("rolls hours into 28 six-hour buckets for 7d", () => {
    const series = selectTimeSeries({
      days,
      hours,
      range: 7,
      emptySixHour: (date) => ({ date, value: 0 }),
    });
    expect(series).toHaveLength(28);
    expect(series.every((row) => Number(row.date.slice(-2)) % 6 === 0)).toBe(true);
  });

  it("prefers dedicated sixHours series", () => {
    const sixHours = [{ date: "2026-06-15T12", value: 9 }];
    expect(
      selectTimeSeries({
        days,
        hours,
        sixHours,
        range: 7,
        emptySixHour: (date) => ({ date, value: 0 }),
      }),
    ).toEqual(sixHours);
  });

  it("falls back to daily 7d series when no hour data exists", () => {
    expect(selectTimeSeries({ days, range: 7 }).map((row) => row.date)).toEqual(
      days.slice(-7).map((row) => row.date),
    );
  });

  it("slices daily series for 30d", () => {
    expect(selectTimeSeries({ days, range: 30 }).map((row) => row.date)).toEqual(
      days.slice(-30).map((row) => row.date),
    );
  });
});
