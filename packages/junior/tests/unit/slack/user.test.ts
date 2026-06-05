import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/config", () => ({
  getSlackBotToken: () => "test-token",
}));

import { resolveSlackResumeRequester } from "@/chat/slack/user";

describe("resolveSlackResumeRequester", () => {
  it("builds identity from stored session requester without a Slack API call", () => {
    vi.stubGlobal("fetch", vi.fn());

    const result = resolveSlackResumeRequester("U123", {
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      userId: "U123",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    vi.unstubAllGlobals();
  });

  it("returns actor id only when no stored requester is present", () => {
    const result = resolveSlackResumeRequester("U456", undefined);

    expect(result.userId).toBe("U456");
    expect(result.email).toBeUndefined();
    expect(result.fullName).toBeUndefined();
    expect(result.userName).toBeUndefined();
  });

  it("returns partial identity when stored requester has only some fields", () => {
    const result = resolveSlackResumeRequester("U789", {
      email: "bob@sentry.io",
    });

    expect(result.userId).toBe("U789");
    expect(result.email).toBe("bob@sentry.io");
    expect(result.fullName).toBeUndefined();
  });
});
