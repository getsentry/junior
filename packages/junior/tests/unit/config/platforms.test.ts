import { describe, expect, it } from "vitest";
import { resolveEnabledChatPlatforms } from "@/chat/platforms";

describe("chat platform config", () => {
  it("enables Slack by default", () => {
    expect(resolveEnabledChatPlatforms(undefined)).toEqual(["slack"]);
  });

  it("normalizes explicit enabled chat platforms", () => {
    expect(
      resolveEnabledChatPlatforms(["github", " slack ", "github"]),
    ).toEqual(["github", "slack"]);
  });

  it("throws when enabled chat platforms contain an unknown platform", () => {
    expect(() => resolveEnabledChatPlatforms(["slack", "email"])).toThrow(
      "enabledPlatforms must contain only: slack, github",
    );
  });
});
