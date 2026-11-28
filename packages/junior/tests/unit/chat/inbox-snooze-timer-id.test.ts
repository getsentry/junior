import { describe, expect, it } from "vitest";
import { snoozeTimerId, snoozeTimerWakeAtMs } from "@/chat/inbox-snoozes/store";

describe("snooze timer ids", () => {
  it("carry the wake time", () => {
    expect(snoozeTimerWakeAtMs(snoozeTimerId(1_780_000_000_000))).toBe(
      1_780_000_000_000,
    );
  });

  it("have no wake time when made before ids carried one", () => {
    expect(
      snoozeTimerWakeAtMs("inbox-snooze:3f2c1d2e-8a4b-4c3d-9e1f-0a1b2c3d4e5f"),
    ).toBeUndefined();
  });
});
