import { describe, expect, it } from "vitest";
import { createNextInputTracker } from "@/chat/services/context-compaction-telemetry";

describe("createNextInputTracker", () => {
  it("returns attributes only for the first request with input after a replacement", () => {
    const tracker = createNextInputTracker();
    expect(tracker.attributes(300_000)).toBeUndefined();

    tracker.replaced("active", 360_000);
    // A failed request reports no input, so the next request counts.
    expect(tracker.attributes(0)).toBeUndefined();
    expect(tracker.attributes(370_000)).toEqual({
      "app.compaction.mode": "active",
      "app.compaction.next_input.size": 370_000,
      "app.compaction.next_input.over_threshold": true,
      "app.compaction.threshold": 360_000,
    });
    expect(tracker.attributes(380_000)).toBeUndefined();

    tracker.replaced("blocking", 360_000);
    expect(tracker.attributes(150_000)).toMatchObject({
      "app.compaction.mode": "blocking",
      "app.compaction.next_input.over_threshold": false,
    });
  });
});
