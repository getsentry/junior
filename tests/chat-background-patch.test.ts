import { describe, expect, it } from "vitest";
import { normalizeIncomingSlackThreadId } from "@/chat/chat-background-patch";

describe("normalizeIncomingSlackThreadId", () => {
  it("keeps canonical slack thread ids unchanged", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:C123:1700000000.100", {
        raw: { channel: "C123", ts: "1700000000.100" }
      })
    ).toBe("slack:C123:1700000000.100");
  });

  it("repairs slack thread ids missing thread timestamp from raw.ts", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:D123:", {
        raw: { channel: "D123", ts: "1700000000.200" }
      })
    ).toBe("slack:D123:1700000000.200");
  });

  it("uses raw.thread_ts when present", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:C123:", {
        raw: { channel: "C123", thread_ts: "1700000000.300", ts: "1700000000.400" }
      })
    ).toBe("slack:C123:1700000000.300");
  });

  it("returns original thread id when raw slack fields are missing", () => {
    expect(normalizeIncomingSlackThreadId("slack:D123:", {})).toBe("slack:D123:");
  });

  it("returns non-slack thread ids as-is", () => {
    expect(normalizeIncomingSlackThreadId("thread-123", {})).toBe("thread-123");
  });
});
