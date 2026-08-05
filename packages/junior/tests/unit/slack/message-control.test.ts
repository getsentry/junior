import { describe, expect, it } from "vitest";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";

describe("stripLeadingSteeringOverride", () => {
  it("strips a steering marker before or after a leading Slack mention", () => {
    expect(stripLeadingSteeringOverride("  !! @U0BOT stop")).toBe(
      "@U0BOT stop",
    );
    expect(stripLeadingSteeringOverride("  <@U0BOT> !! stop")).toBe(
      "  <@U0BOT> stop",
    );
    // Slack adapter plain-text extraction rewrites `<@U…>` to `@U…`.
    expect(stripLeadingSteeringOverride("@U0BOT !! stop")).toBe("@U0BOT stop");
  });

  it("leaves other messages unchanged", () => {
    expect(stripLeadingSteeringOverride("keep going!!")).toBe("keep going!!");
  });
});
