import { describe, expect, it } from "vitest";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";

describe("stripLeadingSteeringOverride", () => {
  it("strips a whitespace-prefixed steering marker", () => {
    expect(stripLeadingSteeringOverride("  !! @U0BOT stop")).toBe(
      "@U0BOT stop",
    );
  });

  it("leaves other messages unchanged", () => {
    expect(stripLeadingSteeringOverride("keep going!!")).toBe("keep going!!");
  });
});
