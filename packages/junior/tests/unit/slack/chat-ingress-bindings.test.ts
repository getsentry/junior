import { describe, expect, it } from "vitest";
import {
  buildQueueIngressDedupKey,
  determineThreadMessageKind,
  normalizeIncomingSlackThreadId,
} from "@/chat/ingress/message-router";

describe("normalizeIncomingSlackThreadId", () => {
  it("keeps canonical slack thread ids unchanged", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:C123:1700000000.100", {
        raw: { channel: "C123", ts: "1700000000.100" },
      }),
    ).toBe("slack:C123:1700000000.100");
  });

  it("repairs slack thread ids missing thread timestamp from raw.ts", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:D123:", {
        raw: { channel: "D123", ts: "1700000000.200" },
      }),
    ).toBe("slack:D123:1700000000.200");
  });

  it("uses raw.thread_ts when present", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:C123:", {
        raw: {
          channel: "C123",
          thread_ts: "1700000000.300",
          ts: "1700000000.400",
        },
      }),
    ).toBe("slack:C123:1700000000.300");
  });

  it("returns original thread id when raw slack fields are missing", () => {
    expect(normalizeIncomingSlackThreadId("slack:D123:", {})).toBe(
      "slack:D123:",
    );
  });

  it("ignores adapter thread id parts and uses raw event fields", () => {
    expect(
      normalizeIncomingSlackThreadId("slack:WRONG:WRONG", {
        raw: { channel: "D123", ts: "1700000000.500" },
      }),
    ).toBe("slack:D123:1700000000.500");
  });

  it("returns non-slack thread ids as-is", () => {
    expect(normalizeIncomingSlackThreadId("thread-123", {})).toBe("thread-123");
  });

  it("returns original thread id when message is null or undefined", () => {
    expect(normalizeIncomingSlackThreadId("slack:C123:", null)).toBe(
      "slack:C123:",
    );
    expect(normalizeIncomingSlackThreadId("slack:C123:", undefined)).toBe(
      "slack:C123:",
    );
  });
});

describe("buildQueueIngressDedupKey", () => {
  it("uses thread and message identifiers", () => {
    expect(
      buildQueueIngressDedupKey("slack:C123:1700000000.100", "1700000000.200"),
    ).toBe("slack:C123:1700000000.100:1700000000.200");
  });
});

describe("determineThreadMessageKind", () => {
  it("routes subscribed messages regardless of mention state", () => {
    expect(
      determineThreadMessageKind({
        isDirectMessage: false,
        isSubscribed: true,
        isMention: false,
      }),
    ).toBe("subscribed_message");
  });

  it("routes explicit mentions in unsubscribed threads", () => {
    expect(
      determineThreadMessageKind({
        isDirectMessage: false,
        isSubscribed: false,
        isMention: true,
      }),
    ).toBe("new_mention");
  });

  it("routes direct messages without requiring an explicit mention", () => {
    expect(
      determineThreadMessageKind({
        isDirectMessage: true,
        isSubscribed: false,
        isMention: false,
      }),
    ).toBe("new_mention");
  });

  it("skips unsubscribed non-mention messages", () => {
    expect(
      determineThreadMessageKind({
        isDirectMessage: false,
        isSubscribed: false,
        isMention: false,
      }),
    ).toBeUndefined();
  });
});
