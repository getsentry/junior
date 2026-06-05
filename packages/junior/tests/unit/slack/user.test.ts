import { describe, expect, it } from "vitest";

import { resolveSlackResumeRequester } from "@/chat/slack/user";

describe("resolveSlackResumeRequester", () => {
  it("builds actor identity directly from the stored session requester", () => {
    const result = resolveSlackResumeRequester({
      slackUserId: "U123",
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    expect(result).toMatchObject({
      userId: "U123",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
  });
});
