import { describe, expect, it } from "vitest";
import {
  isCanvasChannel,
  isConversationChannel,
  isDmChannel,
  normalizeSlackConversationId
} from "@/chat/slack-actions/client";

describe("slack client channel context helpers", () => {
  it("normalizes canonical Slack thread-style identifiers", () => {
    expect(normalizeSlackConversationId("slack:C123:1700000000.000")).toBe("C123");
    expect(normalizeSlackConversationId("slack:D999")).toBe("D999");
  });

  it("returns raw channel IDs unchanged", () => {
    expect(normalizeSlackConversationId("C123")).toBe("C123");
    expect(normalizeSlackConversationId("G123")).toBe("G123");
    expect(normalizeSlackConversationId("D123")).toBe("D123");
  });

  it("handles invalid/empty identifiers safely", () => {
    expect(normalizeSlackConversationId(undefined)).toBeUndefined();
    expect(normalizeSlackConversationId("")).toBeUndefined();
    expect(normalizeSlackConversationId("slack:")).toBeUndefined();
  });

  it("classifies DM/canvas/conversation channels after normalization", () => {
    expect(isDmChannel("slack:D123:1700000000.000")).toBe(true);
    expect(isDmChannel("slack:C123:1700000000.000")).toBe(false);

    expect(isCanvasChannel("slack:C123:1700000000.000")).toBe(true);
    expect(isCanvasChannel("slack:G123:1700000000.000")).toBe(true);
    expect(isCanvasChannel("slack:D123:1700000000.000")).toBe(true);
    expect(isCanvasChannel("slack:X123:1700000000.000")).toBe(false);

    expect(isConversationChannel("slack:C123:1700000000.000")).toBe(true);
    expect(isConversationChannel("slack:G123:1700000000.000")).toBe(true);
    expect(isConversationChannel("slack:D123:1700000000.000")).toBe(false);
  });
});
