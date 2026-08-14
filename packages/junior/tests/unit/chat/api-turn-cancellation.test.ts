import { describe, expect, it } from "vitest";
import { createApiTurnCancellation } from "@/chat/api-turns/cancellation";

describe("API Turn cancellation", () => {
  it("keeps disconnected running work active until it finishes", () => {
    const cancellation = createApiTurnCancellation();
    const signal = cancellation.begin("conversation-1");
    if (!signal) throw new Error("Expected an active Turn signal");

    cancellation.disconnect("conversation-1", signal);

    expect(cancellation.begin("conversation-1")).toBeUndefined();
    cancellation.finish("conversation-1", signal);
    expect(cancellation.begin("conversation-1")).toBeDefined();
  });

  it.each(["disconnect-first", "park-first"] as const)(
    "releases disconnected auth work when %s",
    (order) => {
      const cancellation = createApiTurnCancellation();
      const signal = cancellation.begin("conversation-1");
      if (!signal) throw new Error("Expected an active Turn signal");

      if (order === "disconnect-first") {
        cancellation.disconnect("conversation-1", signal);
        cancellation.park("conversation-1", signal);
      } else {
        cancellation.park("conversation-1", signal);
        cancellation.disconnect("conversation-1", signal);
      }

      expect(cancellation.begin("conversation-1")).toBeDefined();
    },
  );

  it("ignores cancellation after the Turn finishes", () => {
    const cancellation = createApiTurnCancellation();
    const signal = cancellation.begin("conversation-1");
    if (!signal) throw new Error("Expected an active Turn signal");

    cancellation.finish("conversation-1", signal);

    expect(cancellation.cancel("conversation-1")).toBe(false);
    expect(signal.aborted).toBe(false);
  });
});
