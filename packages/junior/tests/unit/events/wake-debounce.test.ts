import { describe, expect, it } from "vitest";
import { remainingEventWakeDelayMs } from "@/chat/events/wake-debounce";

describe("remainingEventWakeDelayMs", () => {
  it("waits the base delay for a single event", () => {
    expect(
      remainingEventWakeDelayMs({
        eventCount: 1,
        firstReceivedAtMs: 1_000,
        nowMs: 1_000,
      }),
    ).toBe(30_000);
  });

  it("adds a step per follow-up event", () => {
    expect(
      remainingEventWakeDelayMs({
        eventCount: 2,
        firstReceivedAtMs: 1_000,
        nowMs: 1_000,
      }),
    ).toBe(35_000);
    expect(
      remainingEventWakeDelayMs({
        eventCount: 3,
        firstReceivedAtMs: 1_000,
        nowMs: 1_000,
      }),
    ).toBe(40_000);
  });

  it("caps the wait measured from the first event", () => {
    expect(
      remainingEventWakeDelayMs({
        eventCount: 20,
        firstReceivedAtMs: 1_000,
        nowMs: 1_000,
      }),
    ).toBe(60_000);
  });

  it("returns undefined once the wait has elapsed", () => {
    expect(
      remainingEventWakeDelayMs({
        eventCount: 1,
        firstReceivedAtMs: 1_000,
        nowMs: 31_000,
      }),
    ).toBeUndefined();
    expect(
      remainingEventWakeDelayMs({
        eventCount: 1,
        firstReceivedAtMs: 1_000,
        nowMs: 30_999,
      }),
    ).toBe(1);
  });

  it("still runs once the cap elapses even with more follow-up events", () => {
    expect(
      remainingEventWakeDelayMs({
        eventCount: 100,
        firstReceivedAtMs: 1_000,
        nowMs: 61_000,
      }),
    ).toBeUndefined();
  });
});
