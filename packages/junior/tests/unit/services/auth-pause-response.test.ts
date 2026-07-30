import { describe, expect, it } from "vitest";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";

describe("buildAuthPauseResponse", () => {
  it("mentions the user and provider without echoing the request", () => {
    expect(buildAuthPauseResponse("U123", "GitHub")).toBe(
      "<@U123> I'll need you to authorize GitHub. I sent you a link.",
    );
  });

  it("omits the mention when no slack user id is available", () => {
    expect(buildAuthPauseResponse(undefined, "Sentry")).toBe(
      "I'll need you to authorize Sentry. I sent you a link.",
    );
  });
});
