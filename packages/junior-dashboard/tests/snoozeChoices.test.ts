import { describe, expect, it } from "vitest";

import { snoozeChoicesAt } from "../src/client/review-desk/snoozeChoices";

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

describe("snoozeChoicesAt", () => {
  it("offers the afternoon and evening of today before noon", () => {
    // Friday, August 7, 10:30.
    expect(menuAt(2026, 7, 7, 10, 30)).toEqual([
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
      ["1 hour", "8/7 18:30"],
      ["3 hours", "8/7 20:30"],
      ["Tomorrow morning", "8/8 9:00"],
      ["Next week", "8/10 9:00"],
    ]);
  });

  it("wakes on Sunday night at Monday 09:00 for both morning choices", () => {
    // Sunday, August 9, 22:00: 3 hours runs into Monday.
    expect(menuAt(2026, 7, 9, 22, 0)).toEqual([
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
});
