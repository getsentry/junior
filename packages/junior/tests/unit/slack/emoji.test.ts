import { describe, expect, it } from "vitest";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";

describe("normalizeSlackEmojiName", () => {
  it("normalizes Slack alias names", () => {
    expect(normalizeSlackEmojiName(" :Thumbs_Up: ")).toBe("thumbs_up");
    expect(normalizeSlackEmojiName("white-check-mark")).toBe(
      "white-check-mark",
    );
  });

  it("preserves documented Slack skin-tone modifiers", () => {
    expect(normalizeSlackEmojiName(":thumbsup::skin-tone-6:")).toBe(
      "thumbsup::skin-tone-6",
    );
  });

  it("rejects unicode emoji glyphs and malformed aliases", () => {
    expect(normalizeSlackEmojiName("✅")).toBeNull();
    expect(normalizeSlackEmojiName(":thumbsup::skin-tone-7:")).toBeNull();
    expect(normalizeSlackEmojiName("")).toBeNull();
  });
});
