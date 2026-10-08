import { describe, expect, it } from "vitest";
import {
  buildAuthPauseResponse,
  describeAuthorizationReason,
} from "@/chat/services/auth-pause-response";

describe("buildAuthPauseResponse", () => {
  it("shows the escaped reason in the public notice", () => {
    expect(
      buildAuthPauseResponse(
        "U123",
        "GitHub",
        "  Update <roadmap> & notify the team  ",
      ),
    ).toBe(
      "<@U123> I need access to your GitHub account to continue. I sent you a private link.\n\n*Why:* Update &lt;roadmap&gt; &amp; notify the team",
    );
  });

  it("falls back to the generic notice without a reason", () => {
    expect(buildAuthPauseResponse("U123", "GitHub")).toBe(
      "<@U123> I need access to your GitHub account to continue. I sent you a private link.",
    );
  });
});

describe("describeAuthorizationReason", () => {
  it("prefers the agent intent, then the triggering tool", () => {
    expect(
      describeAuthorizationReason({
        intent: " search Notion for the offsite doc ",
        toolName: "notion-search",
      }),
    ).toBe("search Notion for the offsite doc");
    expect(describeAuthorizationReason({ toolName: "notion-search" })).toBe(
      "calling `notion-search`",
    );
    expect(describeAuthorizationReason({})).toBeUndefined();
  });
});
