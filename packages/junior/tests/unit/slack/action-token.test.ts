import { describe, expect, it } from "vitest";
import { readSlackActionToken } from "@/chat/slack/action-token";

describe("readSlackActionToken", () => {
  it("parses and trims an action token from a Slack message envelope", () => {
    expect(
      readSlackActionToken({ raw: { action_token: " action-123 " } }),
    ).toBe("action-123");
  });

  it.each([
    undefined,
    null,
    {},
    { raw: null },
    { raw: {} },
    { raw: { action_token: "" } },
    { raw: { action_token: "   " } },
    { raw: { action_token: 123 } },
  ])("rejects an invalid message envelope: %j", (message) => {
    expect(readSlackActionToken(message)).toBeUndefined();
  });
});
