import { afterEach, describe, expect, it, vi } from "vitest";

import { snoozeChoicesAt } from "../src/client/inbox/snoozeChoices";

/** The menu at a local clock, as label and local target time. */
function menuAt(...clock: [number, number, number, number, number]) {
  const nowMs = new Date(...clock).getTime();
  return snoozeChoicesAt(nowMs).map((choice) => {
    const until = new Date(choice.untilMs(nowMs));
    return [
      choice.label,
      `${until.getMonth() + 1}/${until.getDate()} ${until.getHours()}:${String(until.getMinutes()).padStart(2, "0")}`,
    ];
  });
}

/** The local target time of the choice `label` at a local clock. */
function targetAt(
  label: string,
  ...clock: [number, number, number, number, number]
) {
  return menuAt(...clock).find(([choice]) => choice === label)?.[1];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("snoozeChoicesAt", () => {
  it("offers the afternoon and evening of today before noon", () => {
    // Friday, August 7, 10:30.
    expect(menuAt(2026, 7, 7, 10, 30)).toEqual([
      ["15 minutes", "8/7 10:45"],
      ["30 minutes", "8/7 11:00"],
      ["1 hour", "8/7 11:30"],
      ["3 hours", "8/7 13:30"],
      ["This afternoon", "8/7 14:00"],
      ["This evening", "8/7 18:00"],
      ["Tomorrow morning", "8/8 9:00"],
      ["Next week", "8/10 9:00"],
    ]);
  });

  it("drops the afternoon and evening after 17:00", () => {
    expect(menuAt(2026, 7, 7, 17, 30)).toEqual([
      ["15 minutes", "8/7 17:45"],
      ["30 minutes", "8/7 18:00"],
      ["1 hour", "8/7 18:30"],
      ["3 hours", "8/7 20:30"],
      ["Tomorrow morning", "8/8 9:00"],
      ["Next week", "8/10 9:00"],
    ]);
  });

  it("wakes on Sunday night at Monday 09:00 for both morning choices", () => {
    // Sunday, August 9, 22:00: 3 hours runs into Monday.
    expect(menuAt(2026, 7, 9, 22, 0)).toEqual([
      ["15 minutes", "8/9 22:15"],
      ["30 minutes", "8/9 22:30"],
      ["1 hour", "8/9 23:00"],
      ["3 hours", "8/10 1:00"],
      ["Tomorrow morning", "8/10 9:00"],
      ["Next week", "8/10 9:00"],
    ]);
  });

  it("goes a full week ahead from a Monday", () => {
    expect(menuAt(2026, 7, 10, 8, 0).at(-1)).toEqual([
      "Next week",
      "8/17 9:00",
    ]);
  });

  it("wakes at 09:00 today when tomorrow morning is picked before 06:00", () => {
    vi.stubEnv("TZ", "Europe/London");
    // Friday, August 7.
    expect(targetAt("Tomorrow morning", 2026, 7, 7, 0, 42)).toBe("8/7 9:00");
    expect(targetAt("Tomorrow morning", 2026, 7, 7, 5, 59)).toBe("8/7 9:00");
    expect(targetAt("Tomorrow morning", 2026, 7, 7, 6, 0)).toBe("8/8 9:00");
    expect(targetAt("Tomorrow morning", 2026, 7, 7, 23, 30)).toBe("8/8 9:00");
  });

  it("wakes at local 09:00 across a DST change", () => {
    vi.stubEnv("TZ", "Europe/London");
    // Clocks go forward an hour at 01:00 on Sunday, March 29.
    expect(targetAt("Tomorrow morning", 2026, 2, 28, 23, 30)).toBe("3/29 9:00");
    expect(targetAt("Tomorrow morning", 2026, 2, 29, 0, 42)).toBe("3/29 9:00");
    // Clocks go back an hour at 02:00 on Sunday, October 25.
    expect(targetAt("Tomorrow morning", 2026, 9, 25, 0, 42)).toBe("10/25 9:00");
  });

  it("wakes this Monday when next week is picked before 06:00 on a Monday", () => {
    vi.stubEnv("TZ", "Europe/London");
    // Monday, August 10.
    expect(targetAt("Next week", 2026, 7, 10, 0, 42)).toBe("8/10 9:00");
    expect(targetAt("Next week", 2026, 7, 10, 5, 59)).toBe("8/10 9:00");
    expect(targetAt("Next week", 2026, 7, 10, 6, 0)).toBe("8/17 9:00");
    // Sunday, August 9.
    expect(targetAt("Next week", 2026, 7, 9, 23, 30)).toBe("8/10 9:00");
    // Monday, March 30, the day after clocks go forward.
    expect(targetAt("Next week", 2026, 2, 30, 0, 42)).toBe("3/30 9:00");
  });
});
