import { describe, expect, it } from "vitest";
import { SlackActionError } from "@/chat/slack/client";
import { isRetryableSlackPostError } from "@/chat/slack/errors";

describe("isRetryableSlackPostError", () => {
  it.each([
    [
      "an ambiguous network failure",
      Object.assign(new Error(), { code: "ECONNRESET" }),
      true,
    ],
    [
      "a mapped transient failure",
      new SlackActionError("failed", "internal_error"),
      true,
    ],
    [
      "a documented rate limit",
      new SlackActionError("failed", "internal_error", {
        apiError: "ratelimited",
      }),
      true,
    ],
    [
      "an explicit API rejection",
      { data: { error: "channel_not_found" } },
      false,
    ],
    [
      "an unfamiliar mapped API rejection",
      new SlackActionError("failed", "internal_error", {
        apiError: "account_inactive",
      }),
      false,
    ],
    [
      "a mapped permanent failure",
      new SlackActionError("failed", "missing_scope"),
      false,
    ],
  ])("classifies %s", (_name, error, retryable) => {
    expect(isRetryableSlackPostError(error)).toBe(retryable);
  });
});
